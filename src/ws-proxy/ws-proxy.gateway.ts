import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { Server, Socket } from 'socket.io';
import { RedisService } from '../redis/redis.service';
import { compareSemver } from '../common/semver-compare.util';
import { SOCKET_IO_PING_OPTIONS } from '../common/socket-io-options';
import { WsRateLimiterService } from '../common/rate-limit/ws-rate-limiter.service';
import { resolveCorsOrigin } from '../common/cors-origin.util';
import {
  buildResultEnvelope,
  extractPlayerId,
  extractRoomIdFromJoinArgs,
  extractRoomIdFromRoomDeletedArgs,
  gameEventNameForNamespace,
  isGameNamespace,
  isIntentionalClientDisconnect,
  isTerminalGameEnvelope,
} from './ws-proxy-downstream.util';

/**
 * Phase E: a per-connection record. We keep the PWA-side socket, the upstream socket,
 * the bearer token used at handshake time, and the namespace so the periodic sweeper
 * can revalidate authentication without having to crack the token out of socket.io
 * internals on every tick.
 */
interface SessionEntry {
  client: Socket;
  backendSocket: ClientSocket;
  token: string;
  namespace: string;
  playerId: string;
}

interface ParkedSession {
  backendSocket: ClientSocket;
  namespace: string;
  token: string;
  playerId: string;
  lastJoin: { event: string; args: unknown[] } | null;
  pendingEvents: { event: string; args: unknown[] }[];
  disconnectTimer: NodeJS.Timeout;
  onReconnectAttempt: (attempt: number) => void;
  onReconnect: (attempt: number) => void;
}

interface UserTrack {
  clientsByNamespace: Map<string, Socket>;
  lastRoomIdByNamespace: Map<string, string>;
  pendingRoomDeletes: { roomId?: string; args: unknown[] }[];
  resultEmittedRoomIds: Set<string>;
}

export const PROXY_NAMESPACES = [
  '/chat',
  '/rooms',
  '/naval-battle',
  '/chess',
  '/domino',
  '/halma',
  '/uno',
  '/connect-four',
  '/tournaments',
] as const;

function buildWsCors(): { origin: boolean | string[]; credentials: boolean } {
  const origins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return {
    // Same rule as the HTTP CORS in main.ts: explicit origins win; otherwise only
    // known dev/test environments get the permissive reflect-any-origin fallback.
    origin: resolveCorsOrigin(process.env.NODE_ENV, origins),
    credentials: true,
  };
}

@WebSocketGateway({
  cors: buildWsCors(),
  transports: ['websocket', 'polling'],
  ...SOCKET_IO_PING_OPTIONS,
})
export class WsProxyGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer() private readonly io!: Server;
  private readonly logger = new Logger(WsProxyGateway.name);

  /** key=PWA-side client.id → live session record (Phase E). */
  private readonly sessions = new Map<string, SessionEntry>();
  /** key=`${namespace}:${playerId}` → upstream kept alive for PWA transport reconnect (Bug A). */
  private readonly parkedSessions = new Map<string, ParkedSession>();
  /** key=playerId → cross-namespace lobby/game-end ordering (Bug B). */
  private readonly userTracks = new Map<string, UserTrack>();
  /** Handle for the periodic token revalidation sweeper so we can clear it on shutdown. */
  private revalidationTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
    private readonly wsRateLimiter?: WsRateLimiterService,
  ) {}

  afterInit(server: Server): void {
    const downstreamUrl =
      this.configService.getOrThrow<string>('DOWNSTREAM_URL');

    PROXY_NAMESPACES.forEach((ns) => {
      server.of(ns).on('connection', (client: Socket) => {
        void this.bridge(client, ns, downstreamUrl);
      });
    });

    this.logger.log(
      `WsProxyGateway iniciado → proxiando namespaces: ${PROXY_NAMESPACES.join(', ')}`,
    );

    this.startTokenRevalidationSweeper();
  }

  onModuleDestroy(): void {
    if (this.revalidationTimer) {
      clearInterval(this.revalidationTimer);
      this.revalidationTimer = null;
    }
    for (const parked of this.parkedSessions.values()) {
      clearTimeout(parked.disconnectTimer);
      parked.backendSocket.disconnect();
    }
    this.parkedSessions.clear();
  }

  private startTokenRevalidationSweeper(): void {
    const periodMsRaw = Number(
      this.configService.get<string>('WS_TOKEN_REVALIDATE_MS') ?? '300000',
    );
    const periodMs =
      Number.isFinite(periodMsRaw) && periodMsRaw >= 30_000
        ? periodMsRaw
        : 300_000;
    if (periodMs === 0) return;
    this.revalidationTimer = setInterval(() => {
      void this.revalidateActiveSessions();
    }, periodMs);
    this.revalidationTimer.unref?.();
  }

  async revalidateActiveSessions(): Promise<void> {
    for (const [, entry] of this.sessions) {
      try {
        const result = await this.validateActiveToken(entry.token);
        if (result.valid) continue;
        this.recordWsFailure(
          entry.namespace,
          entry.client,
          `token_expired_sweep cause=${result.reason} jti=${result.jti ?? 'unknown'}`,
        );
        entry.client.emit('auth_expired', { reason: 'token_invalid' });
        setTimeout(() => entry.client.disconnect(true), 50);
      } catch (err) {
        this.logger.warn(
          `Revalidacion fallo para ${entry.client.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async validateActiveToken(
    token: string,
  ): Promise<{ valid: boolean; reason: string; jti?: string }> {
    const secret = this.configService.getOrThrow<string>('JWT_SECRET');
    const issuer = this.configService.get<string>('JWT_ISSUER', 'play4cash-api');
    const audience = this.configService.get<string>('JWT_AUDIENCE', 'play4cash-clients');
    let payload: Record<string, unknown>;
    try {
      payload = await this.jwtService.verifyAsync<Record<string, unknown>>(token, {
        secret,
        issuer,
        audience,
      });
    } catch (err) {
      const msg = (err as Error).message || '';
      const reason = msg.includes('expired') ? 'jwt_expired' : 'jwt_invalid';
      return { valid: false, reason };
    }
    if (payload?.typ !== 'access') {
      return { valid: false, reason: 'wrong_typ', jti: payload?.jti as string | undefined };
    }
    const jti = typeof payload.jti === 'string' ? payload.jti : undefined;
    try {
      const ok = await this.redisService.isTokenValid(token);
      if (!ok) return { valid: false, reason: 'not_in_allowlist', jti };
    } catch (err) {
      this.logger.warn(
        `Revalidacion: Redis no disponible, conservando sesion. err=${(err as Error).message}`,
      );
      return { valid: true, reason: 'redis_down_skipped', jti };
    }
    return { valid: true, reason: 'ok', jti };
  }

  private parkKey(namespace: string, playerId: string): string {
    return `${namespace}:${playerId}`;
  }

  private getUserTrack(playerId: string): UserTrack {
    let track = this.userTracks.get(playerId);
    if (!track) {
      track = {
        clientsByNamespace: new Map(),
        lastRoomIdByNamespace: new Map(),
        pendingRoomDeletes: [],
        resultEmittedRoomIds: new Set(),
      };
      this.userTracks.set(playerId, track);
    }
    return track;
  }

  private registerClientNamespace(playerId: string, namespace: string, client: Socket): void {
    this.getUserTrack(playerId).clientsByNamespace.set(namespace, client);
  }

  private unregisterClientNamespace(playerId: string, namespace: string): void {
    const track = this.userTracks.get(playerId);
    if (!track) return;
    track.clientsByNamespace.delete(namespace);
    if (track.clientsByNamespace.size === 0) {
      this.userTracks.delete(playerId);
    }
  }

  /** Max inbound client events allowed per player+namespace within `readEventRateWindowMs()`. */
  private readEventRateLimitMax(): number {
    const raw = Number(this.configService.get<string>('WS_EVENT_RATE_LIMIT_MAX') ?? '30');
    return Number.isFinite(raw) && raw >= 1 ? raw : 30;
  }

  private readEventRateWindowMs(): number {
    const raw = Number(this.configService.get<string>('WS_EVENT_RATE_LIMIT_WINDOW_MS') ?? '10000');
    return Number.isFinite(raw) && raw >= 1000 ? raw : 10_000;
  }

  private async allowEvent(namespace: string, playerId: string): Promise<boolean> {
    if (!this.wsRateLimiter) return true;
    return this.wsRateLimiter.allow(
      `${namespace}:${playerId}`,
      this.readEventRateLimitMax(),
      this.readEventRateWindowMs(),
    );
  }

  private readParkGraceMs(): number {
    // The API owns the durable, anti-forfeit grace period. Keeping the upstream
    // socket alive for 90 seconds hid real disconnects from that watchdog and left
    // rooms stuck. This short bridge grace only absorbs a transport hand-off.
    const raw = Number(this.configService.get<string>('WS_PARK_GRACE_MS') ?? '5000');
    return Number.isFinite(raw) && raw >= 5_000 ? raw : 90_000;
  }

  private async bridge(
    client: Socket,
    namespace: string,
    downstreamUrl: string,
  ): Promise<void> {
    const auth = client.handshake.auth as Record<string, string>;
    const authHeader = client.handshake.headers?.authorization as
      | string
      | undefined;
    const cookieToken = readCookie(client.handshake.headers?.cookie as string | undefined, 'p4c_access');

    // Deliberately no `query.token` fallback: Socket.IO's polling transport is
    // plain HTTP GET, so a token placed in the query string ends up in proxy/CDN
    // access logs and browser history. The PWA authenticates via the httpOnly
    // cookie; any client that can't use cookies should send the token in the
    // handshake `auth` payload instead, which never touches the URL.
    const token =
      cookieToken ||
      auth?.token ||
      authHeader?.replace(/^Bearer\s+/i, '') ||
      '';

    if (!token) {
      this.recordWsFailure(namespace, client, 'missing_token');
      client.disconnect(true);
      return;
    }

    if (!this.passesVersionGate(client, namespace)) {
      return;
    }

    let playerId = '';
    try {
      const secret = this.configService.getOrThrow<string>('JWT_SECRET');
      const issuer = this.configService.get<string>('JWT_ISSUER', 'play4cash-api');
      const audience = this.configService.get<string>('JWT_AUDIENCE', 'play4cash-clients');
      const payload = await this.jwtService.verifyAsync<Record<string, unknown>>(token, {
        secret,
        issuer,
        audience,
      });
      if (payload.typ !== 'access') {
        this.recordWsFailure(namespace, client, 'wrong_typ');
        client.disconnect(true);
        return;
      }
      playerId = extractPlayerId(payload);
    } catch {
      this.recordWsFailure(namespace, client, 'jwt_invalid');
      client.disconnect(true);
      return;
    }

    const ok = await this.redisService.isTokenValid(token);
    if (!ok) {
      this.recordWsFailure(namespace, client, 'token_revoked');
      client.disconnect(true);
      return;
    }

    this.logger.log(`[${namespace}] Cliente conectado: ${client.id}`);
    this.registerClientNamespace(playerId, namespace, client);

    const key = this.parkKey(namespace, playerId);
    const parked = isGameNamespace(namespace) ? this.parkedSessions.get(key) : undefined;
    if (parked) {
      clearTimeout(parked.disconnectTimer);
      this.parkedSessions.delete(key);
      this.logger.log(
        `[${namespace}] Reanudando sesion upstream estacionada para jugador ${playerId}`,
      );
      this.wireSession(client, namespace, token, playerId, parked.backendSocket, {
        lastJoin: parked.lastJoin,
        pendingEvents: parked.pendingEvents,
      });
      client.emit('proxy_reconnected', { namespace, resumed: true });
      return;
    }

    const { auth: upstreamAuth, query: upstreamQuery } = buildUpstreamHandshake(client, token);

    const backendSocket = ioClient(`${downstreamUrl}${namespace}`, {
      auth: upstreamAuth,
      query: upstreamQuery,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: SOCKET_IO_PING_OPTIONS.connectTimeout,
      ...SOCKET_IO_PING_OPTIONS,
    });

    this.wireSession(client, namespace, token, playerId, backendSocket);
  }

  private wireSession(
    client: Socket,
    namespace: string,
    token: string,
    playerId: string,
    backendSocket: ClientSocket,
    resume?: {
      lastJoin: { event: string; args: unknown[] } | null;
      pendingEvents: { event: string; args: unknown[] }[];
    },
  ): void {
    this.sessions.set(client.id, {
      client,
      backendSocket,
      token,
      namespace,
      playerId,
    });

    const pendingEvents = resume?.pendingEvents ?? [];
    const REPLAY_EVENTS = new Set(['join', 'get_state', 'subscribe', 'tournament:join']);
    let lastJoin: { event: string; args: unknown[] } | null = resume?.lastJoin ?? null;

    const replayLastJoin = (): void => {
      if (!lastJoin) return;
      try {
        backendSocket.emit(lastJoin.event, ...lastJoin.args);
      } catch (err) {
        this.logger.warn(
          `[${namespace}] Replay de ${lastJoin.event} fallo para ${client.id}: ${(err as Error).message}`,
        );
      }
    };

    const flushPendingAndReplay = (): void => {
      let replayAlreadyQueued = false;
      for (const { event, args } of pendingEvents.splice(0)) {
        backendSocket.emit(event, ...args);
        if (lastJoin && event === lastJoin.event && args === lastJoin.args) {
          replayAlreadyQueued = true;
        }
      }
      if (!replayAlreadyQueued) replayLastJoin();
    };

    backendSocket.on('connect', () => {
      this.logger.log(
        `[${namespace}] Backend conectado para cliente ${client.id}`,
      );
      flushPendingAndReplay();

      if (namespace === '/rooms' && playerId) {
        const track = this.getUserTrack(playerId);
        const remaining: typeof track.pendingRoomDeletes = [];
        for (const pending of track.pendingRoomDeletes) {
          if (!pending.roomId || track.resultEmittedRoomIds.has(pending.roomId)) {
            client.emit('roomDeleted', ...pending.args);
          } else {
            remaining.push(pending);
          }
        }
        track.pendingRoomDeletes = remaining;
      }
    });

    backendSocket.on('connect_error', (err) => {
      this.logger.warn(
        `[${namespace}] Error backend para ${client.id}: ${err.message} (socket.io reintentara)`,
      );
    });

    const manager = backendSocket.io;

    const onReconnectAttempt = (attempt: number): void => {
      this.logger.log(
        `[${namespace}] Reintentando backend para ${client.id} (intento ${attempt})`,
      );
    };

    const onReconnect = (attempt: number): void => {
      this.logger.log(
        `[${namespace}] Backend reconectado para ${client.id} tras ${attempt} intento(s); replay del ultimo join.`,
      );
      flushPendingAndReplay();
      client.emit('proxy_reconnected', { namespace });
    };

    manager.on('reconnect_attempt', onReconnectAttempt);
    manager.on('reconnect', onReconnect);

    backendSocket.onAny((event: string, ...args: unknown[]) => {
      this.forwardDownstream(client, namespace, playerId, event, args);
    });

    // Rate-limit checks are async (Redis round trip). Chaining each event onto the
    // previous one's completion keeps per-client forwarding strictly in order —
    // firing the checks concurrently could let a later move's Redis round trip
    // finish first and reach the backend out of turn order.
    let inboundChain: Promise<void> = Promise.resolve();

    client.onAny((event: string, ...args: unknown[]) => {
      inboundChain = inboundChain.then(async () => {
        // Player-scoped (not IP-scoped) — reconnecting from a different address
        // doesn't reset the counter. Protects the downstream API/Redis from a
        // single compromised or malicious session flooding game-action events.
        const allowed = await this.allowEvent(namespace, playerId);
        if (!allowed) {
          this.logger.warn(
            `event=ws_event_rate_limited ns=${namespace} sid=${client.id} player=${playerId} evt=${event}`,
          );
          client.emit('rate_limited', { event });
          return;
        }

        if (REPLAY_EVENTS.has(event)) {
          lastJoin = { event, args };
          const roomId = extractRoomIdFromJoinArgs(args);
          if (roomId) {
            this.getUserTrack(playerId).lastRoomIdByNamespace.set(namespace, roomId);
          }
        }
        if (backendSocket.connected) {
          backendSocket.emit(event, ...args);
        } else {
          pendingEvents.push({ event, args });
        }
      }).catch((err) => {
        this.logger.warn(
          `event=ws_event_forward_failed ns=${namespace} sid=${client.id} evt=${event} err=${(err as Error).message}`,
        );
      });
    });

    client.once('disconnect', (reason: string) => {
      this.unregisterClientNamespace(playerId, namespace);
      this.logger.log(
        `[${namespace}] Cliente ${client.id} desconectado (${reason})`,
      );
      pendingEvents.length = 0;
      this.sessions.delete(client.id);

      const shouldPark =
        isGameNamespace(namespace) &&
        playerId &&
        !isIntentionalClientDisconnect(reason);

      if (shouldPark) {
        const graceMs = this.readParkGraceMs();
        const parkKey = this.parkKey(namespace, playerId);
        const disconnectTimer = setTimeout(() => {
          this.logger.log(
            `[${namespace}] Grace expirada para jugador ${playerId} → cerrando socket backend`,
          );
          this.parkedSessions.delete(parkKey);
          backendSocket.disconnect();
        }, graceMs);
        disconnectTimer.unref?.();
        this.parkedSessions.set(parkKey, {
          backendSocket,
          namespace,
          token,
          playerId,
          lastJoin,
          pendingEvents: [],
          disconnectTimer,
          onReconnectAttempt,
          onReconnect,
        });
        this.logger.log(
          `[${namespace}] Sesion estacionada ${graceMs}ms (API mantiene sala; rejoin permitido)`,
        );
        return;
      }

      manager.off('reconnect_attempt', onReconnectAttempt);
      manager.off('reconnect', onReconnect);
      this.logger.log(
        `[${namespace}] Cerrando socket backend para cliente ${client.id}`,
      );
      const parkKey = this.parkKey(namespace, playerId);
      const existing = this.parkedSessions.get(parkKey);
      if (existing) {
        clearTimeout(existing.disconnectTimer);
        this.parkedSessions.delete(parkKey);
      }
      backendSocket.disconnect();
    });

    // A parked upstream can already be connected when a new downstream transport
    // takes ownership. Replay its durable join/get_state immediately for the new PWA.
    if (resume && backendSocket.connected) queueMicrotask(flushPendingAndReplay);
  }

  /**
   * Bug B: emit `result` (roomCloseReason=gameFinished) before the raw game payload and
   * defer lobby `roomDeleted` until after that result for the same room id.
   */
  forwardDownstream(
    client: Socket,
    namespace: string,
    playerId: string,
    event: string,
    args: unknown[],
  ): void {
    if (event === 'roomDeleted') {
      const roomId = extractRoomIdFromRoomDeletedArgs(args);
      const track = this.getUserTrack(playerId);
      if (roomId && track.resultEmittedRoomIds.has(roomId)) {
        client.emit(event, ...args);
        return;
      }
      track.pendingRoomDeletes.push({ roomId, args });
      return;
    }

    const isGameEvent =
      isGameNamespace(namespace) && event === gameEventNameForNamespace(namespace);
    if (isGameEvent && isTerminalGameEnvelope(args)) {
      const track = this.getUserTrack(playerId);
      const roomId = track.lastRoomIdByNamespace.get(namespace);

      client.emit('result', buildResultEnvelope(args));
      client.emit(event, ...args);

      if (roomId) {
        track.resultEmittedRoomIds.add(roomId);
        const lobbyClient = track.clientsByNamespace.get('/rooms');
        if (lobbyClient) {
          const remaining: typeof track.pendingRoomDeletes = [];
          for (const pending of track.pendingRoomDeletes) {
            if (pending.roomId === roomId) {
              lobbyClient.emit('roomDeleted', ...pending.args);
            } else {
              remaining.push(pending);
            }
          }
          track.pendingRoomDeletes = remaining;
        }
      }
      return;
    }

    client.emit(event, ...args);
  }

  private passesVersionGate(client: Socket, namespace: string): boolean {
    const minVersion = (this.configService.get<string>('PWA_MIN_VERSION') || '').trim();
    if (!minVersion) return true;

    const reported = readClientVersion(client);
    if (reported && compareSemver(reported, minVersion) >= 0) return true;

    this.recordWsFailure(namespace, client, 'version_mismatch');
    client.emit('version_mismatch', { requiredVersion: minVersion });
    setTimeout(() => client.disconnect(true), 50);
    return false;
  }

  private recordWsFailure(namespace: string, client: Socket, reason: string): void {
    const ip = (
      client.handshake?.address ||
      (client.conn as { remoteAddress?: string } | undefined)?.remoteAddress ||
      'unknown'
    ).toString();
    this.logger.warn(
      `event=ws_rejected reason=${reason} ns=${namespace} sid=${client.id} ip=${ip}`,
    );
  }
}

function readClientVersion(client: Socket): string {
  const auth = client.handshake.auth as Record<string, unknown> | undefined;
  const query = client.handshake.query as Record<string, unknown> | undefined;
  const headers = client.handshake.headers as Record<string, unknown> | undefined;
  const headerValue = headers?.['x-app-version'];
  const candidate =
    (auth?.appVersion as string | undefined) ||
    (query?.appVersion as string | undefined) ||
    (Array.isArray(headerValue) ? headerValue[0] : (headerValue as string | undefined)) ||
    '';
  return String(candidate).trim();
}

const UPSTREAM_LANG_ALLOWED = new Set(['es', 'en', 'fr', 'de', 'it', 'pt']);

function handshakeString(
  auth: Record<string, unknown> | undefined,
  query: Record<string, unknown> | undefined,
  key: string,
): string {
  const raw = auth?.[key] ?? query?.[key];
  if (raw == null) return '';
  const s = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return s.trim();
}

export function buildUpstreamHandshake(
  client: Socket,
  token: string,
): { auth: Record<string, string>; query: Record<string, string> } {
  const authHs = client.handshake.auth as Record<string, unknown> | undefined;
  const queryHs = client.handshake.query as Record<string, unknown> | undefined;

  const upstreamAuth: Record<string, string> = { token };
  const upstreamQuery: Record<string, string> = { token };

  const langRaw = handshakeString(authHs, queryHs, 'lang').toLowerCase();
  if (langRaw && UPSTREAM_LANG_ALLOWED.has(langRaw)) {
    upstreamAuth.lang = langRaw;
    upstreamQuery.lang = langRaw;
  }

  const appVersion = readClientVersion(client);
  if (appVersion) {
    upstreamAuth.appVersion = appVersion;
    upstreamQuery.appVersion = appVersion;
  }

  return { auth: upstreamAuth, query: upstreamQuery };
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}
