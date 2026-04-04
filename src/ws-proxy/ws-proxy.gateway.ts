import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { Server, Socket } from 'socket.io';

// Namespaces del downstream que el gateway debe proxiar
const PROXY_NAMESPACES = [
  '/chat',
  '/rooms',
  '/naval-battle',
  '/chess',
  '/domino',
  '/halma',
];

@WebSocketGateway({
  cors: { origin: '*', credentials: true },
  transports: ['websocket', 'polling'],
})
export class WsProxyGateway implements OnGatewayInit {
  @WebSocketServer() private readonly io!: Server;
  private readonly logger = new Logger(WsProxyGateway.name);

  // clientSocketId → socket.io-client hacia el backend
  private readonly sessions = new Map<string, ClientSocket>();

  constructor(private readonly configService: ConfigService) {}

  afterInit(server: Server): void {
    const downstreamUrl =
      this.configService.getOrThrow<string>('DOWNSTREAM_URL');

    // Registrar handler de conexión en cada namespace
    PROXY_NAMESPACES.forEach((ns) => {
      server.of(ns).on('connection', (client: Socket) => {
        this.bridge(client, ns, downstreamUrl);
      });
    });

    this.logger.log(
      `WsProxyGateway iniciado → proxiando namespaces: ${PROXY_NAMESPACES.join(', ')}`,
    );
  }

  private bridge(
    client: Socket,
    namespace: string,
    downstreamUrl: string,
  ): void {
    // ── Extraer token del handshake (auth / query / header) ────────────────
    const auth = client.handshake.auth as Record<string, string>;
    const query = client.handshake.query as Record<string, string>;
    const authHeader = client.handshake.headers?.authorization as
      | string
      | undefined;

    const token =
      auth?.token ||
      query?.token ||
      authHeader?.replace('Bearer ', '') ||
      '';

    this.logger.log(`[${namespace}] Cliente conectado: ${client.id}`);

    // ── Abrir socket hacia el backend con el mismo token ───────────────────
    const backendSocket = ioClient(`${downstreamUrl}${namespace}`, {
      auth: { token },
      query: { token },
      transports: ['websocket', 'polling'],
      reconnection: false, // el gateway gestiona el ciclo de vida
      timeout: 5000,
    });

    this.sessions.set(client.id, backendSocket);

    backendSocket.on('connect', () => {
      this.logger.log(
        `[${namespace}] Backend conectado para cliente ${client.id}`,
      );
    });

    backendSocket.on('connect_error', (err) => {
      this.logger.error(
        `[${namespace}] Error backend para ${client.id}: ${err.message}`,
      );
      client.emit('exception', { message: 'Backend no disponible' });
    });

    // ── Backend → Cliente (transparente) ──────────────────────────────────
    backendSocket.onAny((event: string, ...args: unknown[]) => {
      client.emit(event, ...args);
    });

    // ── Cliente → Backend (transparente) ──────────────────────────────────
    client.onAny((event: string, ...args: unknown[]) => {
      if (backendSocket.connected) {
        backendSocket.emit(event, ...args);
      }
    });

    // ── Propagación de desconexión: cliente cae → backend cae inmediatamente
    // Esto activa el handleDisconnect del backend y arranca el periodo de gracia.
    client.once('disconnect', (reason: string) => {
      this.logger.log(
        `[${namespace}] Cliente ${client.id} desconectado (${reason}) → cerrando socket backend`,
      );
      backendSocket.disconnect();
      this.sessions.delete(client.id);
    });
  }
}
