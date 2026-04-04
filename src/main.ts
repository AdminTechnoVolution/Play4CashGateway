import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as http from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  const port = configService.get<number>('PORT', 4000);
  const downstreamUrl = configService.getOrThrow<string>('DOWNSTREAM_URL');
  const corsOrigins = configService
    .get<string>('CORS_ORIGINS', '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // ─── CORS ────────────────────────────────────────────────────────────────
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // ─── Global validation ────────────────────────────────────────────────────
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // ─── Build the underlying HTTP server ────────────────────────────────────
  const expressApp = app.getHttpAdapter().getInstance();
  const httpServer: http.Server = http.createServer(expressApp);

  // ─── WebSocket proxy for all Socket.IO namespaces ────────────────────────
  //
  //  The downstream uses Socket.IO with these namespaces:
  //    /chat  /rooms  /naval-battle  /chess  /domino  /halma
  //
  //  Socket.IO polling starts at `GET /socket.io/` (or /<namespace>/socket.io/).
  //  We proxy the raw `upgrade` event on the HTTP server so that both the
  //  long-polling and WebSocket transports are forwarded transparently.
  //
  const wsNamespaces = [
    '/chat',
    '/rooms',
    '/naval-battle',
    '/chess',
    '/domino',
    '/halma',
    '/socket.io', // root namespace fallback
  ];

  const wsProxy = createProxyMiddleware({
    target: downstreamUrl,
    changeOrigin: true,
    ws: true,
  });

  // Attach ws proxy to each namespace upgrade
  httpServer.on('upgrade', (req, socket, head) => {
    const isSocketIo = wsNamespaces.some(
      (ns) => req.url?.startsWith(ns) || req.url?.includes('/socket.io'),
    );

    if (isSocketIo) {
      logger.debug(`WS upgrade → ${req.url}`);
      (wsProxy as any).upgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  // Also proxy Socket.IO HTTP long-polling through Express
  wsNamespaces.forEach((ns) => {
    expressApp.use(`${ns}/socket.io`, wsProxy);
  });
  expressApp.use('/socket.io', wsProxy);

  await app.init();

  httpServer.listen(port, () => {
    logger.log(`API Gateway running on port ${port}`);
    logger.log(`Proxying REST + WS → ${downstreamUrl}`);
  });
}

bootstrap();

