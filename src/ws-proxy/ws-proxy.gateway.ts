import { Logger } from '@nestjs/common';
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

const PROXY_NAMESPACES = [
  '/chat',
  '/rooms',
  '/naval-battle',
  '/chess',
  '/domino',
  '/halma',
];

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
export class WsProxyGateway implements OnGatewayInit {
  @WebSocketServer() private readonly io!: Server;
  private readonly logger = new Logger(WsProxyGateway.name);

  private readonly sessions = new Map<string, ClientSocket>();

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

    const backendSocket = ioClient(`${downstreamUrl}${namespace}`, {
      auth: { token },
      query: { token },
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 5000,
    });

    this.sessions.set(client.id, backendSocket);

    const pendingEvents: { event: string; args: unknown[] }[] = [];

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
      this.logger.error(
        `[${namespace}] Error backend para ${client.id}: ${err.message}`,
      );
      pendingEvents.length = 0;
      client.emit('exception', { message: 'Backend no disponible' });
    });

    backendSocket.onAny((event: string, ...args: unknown[]) => {
      client.emit(event, ...args);
    });

    client.onAny((event: string, ...args: unknown[]) => {
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
