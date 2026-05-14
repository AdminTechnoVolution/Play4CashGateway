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
}

export const PROXY_NAMESPACES = [
  '/chat',
  '/rooms',
  '/naval-battle',
  '/chess',
  '/domino',
  '/halma',
  '/uno',
] as const;

function buildWsCors(): { origin: boolean | string[]; credentials: boolean } {
  const origins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return {
    origin: origins.length > 0 ? origins : true,
    credentials: true,
  };
}

@WebSocketGateway({
  cors: buildWsCors(),
  transports: ['websocket', 'polling'],
})
export class WsProxyGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer() private readonly io!: Server;
  private readonly logger = new Logger(WsProxyGateway.name);

  /** key=PWA-side client.id → live session record (Phase E). */
  private readonly sessions = new Map<string, SessionEntry>();
  /** Handle for the periodic token revalidation sweeper so we can clear it on shutdown. */
  private revalidationTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
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

    // Phase E: periodically revalidate every active session's JWT against the Redis
    // allowlist. Without this, a stolen/revoked access token would stay usable for
    // the entire socket lifetime (which can be hours during a long match).
    this.startTokenRevalidationSweeper();
  }

  /**
   * NestJS module destroy hook — stops the revalidation timer so hot-reload / shutdown
   * doesn't leave background work running.
   */
  onModuleDestroy(): void {
    if (this.revalidationTimer) {
      clearInterval(this.revalidationTimer);
      this.revalidationTimer = null;
    }
  }

  /**
   * Phase E: sweeper that fires every `WS_TOKEN_REVALIDATE_MS` (default 5 min) and
   * runs each active session through {@link validateActiveToken}. Any session whose
   * token has expired or been revoked is notified with `auth_expired` and then
   * disconnected so the PWA can refresh + reconnect cleanly.
   *
   * Implementation notes:
   *  - We intentionally use `setInterval` rather than `@nestjs/schedule` to avoid
   *    pulling a new dependency into a Gateway that has no other Cron jobs.
   *  - Each tick is fenced inside try/catch so a single bad token never poisons the
   *    rest of the sweep.
   */
  private startTokenRevalidationSweeper(): void {
    const periodMsRaw = Number(
      this.configService.get<string>('WS_TOKEN_REVALIDATE_MS') ?? '300000',
    );
    const periodMs =
      Number.isFinite(periodMsRaw) && periodMsRaw >= 30_000
        ? periodMsRaw
        : 300_000;
    // Skip when explicitly disabled (set to 0). Helps E2E tests that don't want a
    // background interval keeping the process alive.
    if (periodMs === 0) return;
    this.revalidationTimer = setInterval(() => {
      void this.revalidateActiveSessions();
    }, periodMs);
    // `unref()` keeps the timer from blocking process exit when it's the only handle
    // still pending (Node's natural shutdown behaviour stays intact).
    this.revalidationTimer.unref?.();
  }

  /** Public for tests; the production path is the interval started in `afterInit`. */
  async revalidateActiveSessions(): Promise<void> {
    for (const [, entry] of this.sessions) {
      try {
        const result = await this.validateActiveToken(entry.token);
        if (result.valid) continue;
        // Granular logging so production can tell whether the kick is caused by
        // JWT exp/signature drift (e.g. PWA holding an old short-TTL token) or by
        // the access token not being present in the Redis allowlist (e.g. Redis
        // restarted, key mismatch between API and Gateway, or `JWT_ACCESS_TOKEN_TTL_SECS`
        // expired the allowlist entry before the JWT `exp` claim).
        this.recordWsFailure(
          entry.namespace,
          entry.client,
          `token_expired_sweep cause=${result.reason} jti=${result.jti ?? 'unknown'}`,
        );
        // Keep the wire-level `reason` stable so the PWA's listener contract doesn't
        // change. Operators see the granular cause via the server log above.
        entry.client.emit('auth_expired', { reason: 'token_invalid' });
        // 50 ms gives Socket.IO time to flush the event over polling before we tear
        // the transport down (same trick we use for `version_mismatch`).
        setTimeout(() => entry.client.disconnect(true), 50);
      } catch (err) {
        this.logger.warn(
          `Revalidacion fallo para ${entry.client.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Re-runs both auth gates (JWT signature/expiration + Redis allowlist). Returns
   * a structured result so callers (and ops logs) can tell the two failure modes
   * apart. Any exception is treated as "no longer valid" except a Redis outage,
   * which keeps the session and waits for the next sweep.
   */
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
      // Conservative: a Redis hiccup should not flood the PWA with reconnects.
      // Log and treat as valid for this tick; the next sweep will retry.
      this.logger.warn(
        `Revalidacion: Redis no disponible, conservando sesion. err=${(err as Error).message}`,
      );
      return { valid: true, reason: 'redis_down_skipped', jti };
    }
    return { valid: true, reason: 'ok', jti };
  }

  private async bridge(
    client: Socket,
    namespace: string,
    downstreamUrl: string,
  ): Promise<void> {
    const auth = client.handshake.auth as Record<string, string>;
    const query = client.handshake.query as Record<string, string>;
    const authHeader = client.handshake.headers?.authorization as
      | string
      | undefined;

    const token =
      auth?.token ||
      query?.token ||
      authHeader?.replace(/^Bearer\s+/i, '') ||
      '';

    if (!token) {
      this.recordWsFailure(namespace, client, 'missing_token');
      client.disconnect(true);
      return;
    }

    // Version gate (only if PWA_MIN_VERSION is configured). Emits a custom event so the
    // PWA can switch its modal into "forced update" mode before disconnecting.
    if (!this.passesVersionGate(client, namespace)) {
      return;
    }

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

    // Phase D: enable upstream reconnection so a brief API pod restart or transport
    // flap no longer requires the PWA to manually reconnect. socket.io client v4
    // retries forever by default; we cap attempts so a permanently-down API surfaces
    // as a clean error to the client instead of hanging in pending state.
    const backendSocket = ioClient(`${downstreamUrl}${namespace}`, {
      auth: { token },
      query: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: 5000,
    });

    // Phase E: store enough context for the revalidation sweeper to call back into
    // this session without having to crack open socket.io internals.
    this.sessions.set(client.id, {
      client,
      backendSocket,
      token,
      namespace,
    });

    const pendingEvents: { event: string; args: unknown[] }[] = [];
    // Phase D: re-bridge memory. After a successful reconnect to the API, the
    // downstream Socket.IO server sees a brand-new `client.id` and has no record
    // of the room/subscription this proxied client previously joined. We remember
    // the last `join`/`subscribe` event so we can replay it after `reconnect` and
    // keep the PWA from silently going stale.
    let lastJoin: { event: string; args: unknown[] } | null = null;

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

    backendSocket.on('connect', () => {
      this.logger.log(
        `[${namespace}] Backend conectado para cliente ${client.id}`,
      );
      for (const { event, args } of pendingEvents) {
        backendSocket.emit(event, ...args);
      }
      pendingEvents.length = 0;
    });

    backendSocket.on('connect_error', (err) => {
      this.logger.warn(
        `[${namespace}] Error backend para ${client.id}: ${err.message} (socket.io reintentara)`,
      );
    });

    // Phase D: the Manager dispatches reconnect events through `.io`. Persist the
    // reference up front so we can clean listeners on teardown.
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
      // Flush anything the client queued while the upstream was bouncing, then
      // re-issue the original join/subscribe so the API re-binds the new socket id
      // to the player's room/subscription.
      replayLastJoin();
      for (const { event, args } of pendingEvents) {
        backendSocket.emit(event, ...args);
      }
      pendingEvents.length = 0;
      // Inform the PWA so it can decide whether to refetch lobby state.
      client.emit('proxy_reconnected', { namespace });
    };

    const onReconnectFailed = (): void => {
      this.logger.error(
        `[${namespace}] Reconexion al backend agotada para ${client.id}; cerrando cliente.`,
      );
      pendingEvents.length = 0;
      client.emit('exception', { message: 'Backend no disponible' });
      client.disconnect(true);
    };

    manager.on('reconnect_attempt', onReconnectAttempt);
    manager.on('reconnect', onReconnect);
    manager.on('reconnect_failed', onReconnectFailed);

    backendSocket.onAny((event: string, ...args: unknown[]) => {
      client.emit(event, ...args);
    });

    client.onAny((event: string, ...args: unknown[]) => {
      // Cache rejoin payloads so we can replay them after a backend reconnect.
      // The API gateways expose `join` (games + chat) and `subscribe` (lobby).
      if (event === 'join' || event === 'subscribe') {
        lastJoin = { event, args };
      }
      if (backendSocket.connected) {
        backendSocket.emit(event, ...args);
      } else {
        pendingEvents.push({ event, args });
      }
    });

    client.once('disconnect', (reason: string) => {
      this.logger.log(
        `[${namespace}] Cliente ${client.id} desconectado (${reason}) → cerrando socket backend`,
      );
      pendingEvents.length = 0;
      manager.off('reconnect_attempt', onReconnectAttempt);
      manager.off('reconnect', onReconnect);
      manager.off('reconnect_failed', onReconnectFailed);
      backendSocket.disconnect();
      this.sessions.delete(client.id);
    });
  }

  /**
   * Returns true if no version gate is active OR the client's reported version is at or
   * above `PWA_MIN_VERSION`. On rejection emits `version_mismatch` so the client can show
   * a forced-update prompt, then disconnects after a short flush window.
   */
  private passesVersionGate(client: Socket, namespace: string): boolean {
    const minVersion = (this.configService.get<string>('PWA_MIN_VERSION') || '').trim();
    if (!minVersion) return true;

    const reported = readClientVersion(client);
    if (reported && compareSemver(reported, minVersion) >= 0) return true;

    this.recordWsFailure(namespace, client, 'version_mismatch');
    client.emit('version_mismatch', { requiredVersion: minVersion });
    // 50 ms gives Socket.IO time to flush the event before the underlying transport closes.
    setTimeout(() => client.disconnect(true), 50);
    return false;
  }

  /** Structured WS-auth rejection log (no token bytes). */
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

/**
 * Pulls the PWA's reported version from the handshake. Order: auth payload, query string,
 * header. Returns empty string when the client didn't supply one.
 */
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
