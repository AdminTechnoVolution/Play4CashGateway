import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Server, Socket } from 'socket.io';
import { compareSemver } from '../common/semver-compare.util';
import { SOCKET_IO_PING_OPTIONS } from '../common/socket-io-options';
import { RedisService } from '../redis/redis.service';
import { buildResultEnvelope, isTerminalGameEnvelope } from './ws-proxy-downstream.util';

const NAMESPACE = '/connect-four';
const EVENT = 'connect-four';
const EDGE_COMMAND_STREAM = 'p4c:rt:connect-four:commands';
const EDGE_EVENT_STREAM = 'p4c:rt:connect-four:events';
const EDGE_STREAM_MAXLEN = '10000';

type EdgeCommandName = 'join' | 'get_state' | 'drop_disc' | 'forfeit' | 'disconnect';

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
  namespace: NAMESPACE,
  cors: buildWsCors(),
  transports: ['websocket', 'polling'],
  ...SOCKET_IO_PING_OPTIONS,
})
export class ConnectFourEdgeGateway
  implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy
{
  @WebSocketServer() private readonly io!: Server;
  private readonly logger = new Logger(ConnectFourEdgeGateway.name);
  private readonly socketsByPlayer = new Map<string, Set<string>>();
  private eventReaderRunning = false;
  private lastEventId = '$';

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  afterInit(): void {
    this.eventReaderRunning = true;
    void this.readEdgeEvents();
    this.logger.log(`${NAMESPACE} edge realtime listo via Redis Streams`);
  }

  onModuleDestroy(): void {
    this.eventReaderRunning = false;
  }

  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      this.recordWsFailure(client, 'missing_token');
      client.disconnect(true);
      return;
    }
    if (!this.passesVersionGate(client)) return;

    try {
      const payload = await this.verifyToken(token);
      const playerId = String(payload.sub || payload.userId || payload.id || '');
      if (!playerId) {
        this.recordWsFailure(client, 'missing_player_id');
        client.disconnect(true);
        return;
      }

      const tokenIsValid = await this.redisService.isTokenValid(token);
      if (!tokenIsValid) {
        this.recordWsFailure(client, 'token_not_allowlisted');
        client.disconnect(true);
        return;
      }

      client.data.token = token;
      client.data.player_id = playerId;
      client.data.lang = this.getLang(client);
      this.registerPlayerSocket(playerId, client.id);
      this.logger.log(`event=connect_four_edge_connected sid=${client.id} player=${playerId}`);
    } catch (err) {
      this.recordWsFailure(client, `token_invalid message=${(err as Error).message}`);
      client.disconnect(true);
    }
  }

  @SubscribeMessage('join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { room_id?: string },
  ): Promise<void> {
    await this.publishCommand(client, 'join', payload ?? {});
  }

  @SubscribeMessage('get_state')
  async handleGetState(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { room_id?: string },
  ): Promise<void> {
    await this.publishCommand(client, 'get_state', payload ?? {});
  }

  @SubscribeMessage('drop_disc')
  async handleDropDisc(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { room_id?: string; col?: number; expectedRevision?: number },
  ): Promise<void> {
    await this.publishCommand(client, 'drop_disc', payload ?? {});
  }

  @SubscribeMessage('forfeit')
  async handleForfeit(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { room_id?: string },
  ): Promise<void> {
    await this.publishCommand(client, 'forfeit', payload ?? {});
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const playerId = String(client.data?.player_id || '');
    if (playerId) this.unregisterPlayerSocket(playerId, client.id);
    const roomId = String(client.data?.room_id || '');
    if (playerId && roomId) {
      await this.publishCommand(client, 'disconnect', { room_id: roomId }).catch((err) => {
        this.logger.warn(`event=connect_four_edge_disconnect_publish_failed sid=${client.id} err=${err.message}`);
      });
    }
  }

  private async verifyToken(token: string): Promise<Record<string, unknown>> {
    const secret = this.configService.getOrThrow<string>('JWT_SECRET');
    const issuer = this.configService.get<string>('JWT_ISSUER', 'play4cash-api');
    const audience = this.configService.get<string>('JWT_AUDIENCE', 'play4cash-clients');
    return this.jwtService.verifyAsync<Record<string, unknown>>(token, {
      secret,
      issuer,
      audience,
    });
  }

  private async publishCommand(
    client: Socket,
    event: EdgeCommandName,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const playerId = String(client.data?.player_id || '');
    if (!playerId) {
      client.disconnect(true);
      return;
    }
    const commandId = randomUUID();
    const roomId = String(payload?.room_id || client.data?.room_id || '');
    await this.redis.xadd(
      EDGE_COMMAND_STREAM,
      'MAXLEN',
      '~',
      EDGE_STREAM_MAXLEN,
      '*',
      'commandId',
      commandId,
      'event',
      event,
      'socketId',
      client.id,
      'playerId',
      playerId,
      'roomId',
      roomId,
      'payload',
      JSON.stringify(payload ?? {}),
      'lang',
      this.getLang(client),
      'issuedAt',
      new Date().toISOString(),
    );
  }

  private async readEdgeEvents(): Promise<void> {
    while (this.eventReaderRunning) {
      try {
        const response = await (this.redis as any).xread(
          'BLOCK',
          5000,
          'COUNT',
          50,
          'STREAMS',
          EDGE_EVENT_STREAM,
          this.lastEventId,
        );
        if (!response) continue;
        for (const stream of response) {
          for (const [id, fields] of stream[1]) {
            this.lastEventId = id;
            await this.routeEdgeEvent(this.parseFields(fields));
          }
        }
      } catch (err) {
        this.logger.warn(`ConnectFour edge event reader retry: ${(err as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private parseFields(fields: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      out[String(fields[i])] = String(fields[i + 1] ?? '');
    }
    return out;
  }

  private async routeEdgeEvent(fields: Record<string, string>): Promise<void> {
    const event = fields.event || EVENT;
    let payload: Record<string, unknown> = {};
    try {
      payload = fields.payload ? JSON.parse(fields.payload) : {};
    } catch {
      payload = {};
    }

    if (event === 'edge:join-room') {
      this.applyJoinRoom(fields.socketId, payload);
      return;
    }

    switch (fields.target) {
      case 'socket':
        this.emitToSocket(fields.socketId, event, payload);
        break;
      case 'player':
        this.emitToPlayer(fields.playerId, event, payload);
        break;
      case 'room':
        if (fields.roomId) this.io.to(fields.roomId).emit(event, payload);
        break;
      case 'spectators':
        this.emitToSpectators(fields.roomId, event, payload);
        break;
      default:
        this.logger.warn(`event=connect_four_edge_unknown_target target=${fields.target}`);
    }
  }

  private applyJoinRoom(socketId: string, payload: Record<string, unknown>): void {
    const socket = (this.io as any).sockets.get(socketId) as Socket | undefined;
    if (!socket) return;
    const roomId = String(payload.roomId || '');
    if (!roomId) return;
    void socket.join(roomId);
    socket.data.room_id = roomId;
    socket.data.isSpectator = Boolean(payload.isSpectator);
    socket.data.playerNum = Number(payload.playerNum || 0);
  }

  private emitToSocket(socketId: string, event: string, payload: Record<string, unknown>): void {
    const socket = (this.io as any).sockets.get(socketId) as Socket | undefined;
    if (!socket) return;
    this.emitBrowserEvent(socket, event, payload);
  }

  private emitToPlayer(playerId: string, event: string, payload: Record<string, unknown>): void {
    const socketIds = this.socketsByPlayer.get(playerId);
    if (!socketIds) return;
    for (const socketId of socketIds) {
      const socket = (this.io as any).sockets.get(socketId) as Socket | undefined;
      if (socket) this.emitBrowserEvent(socket, event, payload);
    }
  }

  private emitToSpectators(roomId: string, event: string, payload: Record<string, unknown>): void {
    if (!roomId) return;
    const room = (this.io as any).adapter?.rooms?.get(roomId) as Set<string> | undefined;
    if (!room) return;
    for (const socketId of room) {
      const socket = (this.io as any).sockets.get(socketId) as Socket | undefined;
      if (socket?.data?.isSpectator) {
        this.emitBrowserEvent(socket, event, payload);
      }
    }
  }

  private emitBrowserEvent(socket: Socket, event: string, payload: Record<string, unknown>): void {
    if (event === EVENT && isTerminalGameEnvelope([payload])) {
      socket.emit('result', buildResultEnvelope([payload]));
    }
    socket.emit(event, payload);
  }

  private registerPlayerSocket(playerId: string, socketId: string): void {
    let sockets = this.socketsByPlayer.get(playerId);
    if (!sockets) {
      sockets = new Set<string>();
      this.socketsByPlayer.set(playerId, sockets);
    }
    sockets.add(socketId);
  }

  private unregisterPlayerSocket(playerId: string, socketId: string): void {
    const sockets = this.socketsByPlayer.get(playerId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size === 0) this.socketsByPlayer.delete(playerId);
  }

  private getLang(client: Socket): string {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    const query = client.handshake.query as Record<string, unknown> | undefined;
    const raw = auth?.lang ?? query?.lang ?? client.data?.lang ?? 'en';
    const lang = Array.isArray(raw) ? String(raw[0]) : String(raw);
    return ['es', 'en', 'fr', 'de', 'it', 'pt'].includes(lang) ? lang : 'en';
  }

  private extractToken(client: Socket): string {
    const auth = client.handshake.auth as Record<string, string> | undefined;
    const query = client.handshake.query as Record<string, string> | undefined;
    const authHeader = client.handshake.headers?.authorization as string | undefined;
    return (
      readCookie(client.handshake.headers?.cookie as string | undefined, 'p4c_access') ||
      auth?.token ||
      query?.token ||
      authHeader?.replace(/^Bearer\s+/i, '') ||
      ''
    );
  }

  private passesVersionGate(client: Socket): boolean {
    const minVersion = (this.configService.get<string>('PWA_MIN_VERSION') || '').trim();
    if (!minVersion) return true;
    const reported = readClientVersion(client);
    if (reported && compareSemver(reported, minVersion) >= 0) return true;
    this.recordWsFailure(client, 'version_mismatch');
    client.emit('version_mismatch', { requiredVersion: minVersion });
    setTimeout(() => client.disconnect(true), 50);
    return false;
  }

  private recordWsFailure(client: Socket, reason: string): void {
    const ip = (
      client.handshake?.address ||
      (client.conn as { remoteAddress?: string } | undefined)?.remoteAddress ||
      'unknown'
    ).toString();
    this.logger.warn(`event=ws_rejected reason=${reason} ns=${NAMESPACE} sid=${client.id} ip=${ip}`);
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
