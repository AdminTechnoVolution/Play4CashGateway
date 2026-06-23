import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import {
  createGatewayRateLimitMiddleware,
  resolveGatewayRateLimitConfig,
} from './common/rate-limit/gateway-rate-limit';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // bodyParser deshabilitado: el gateway proxia streams REST sin parsear bodies.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const configService = app.get(ConfigService);
  const redisClient = app.get<Redis>('REDIS_CLIENT');
  const rateLimitConfig = resolveGatewayRateLimitConfig(
    configService.get<unknown>('RATE_LIMIT_WINDOW_MS'),
    configService.get<unknown>('RATE_LIMIT_MAX'),
  );

  // Configuración de Seguridad (Helmet)
  app.set('trust proxy', 1);
  app.use(helmet());

  // Configuración de Rate Limiting
  const limiter = createGatewayRateLimitMiddleware({
    redis: redisClient,
    windowMs: rateLimitConfig.windowMs,
    max: rateLimitConfig.max,
  });
  app.use(limiter);

  const port = configService.get<number>('PORT', 4000);
  const downstreamUrl = configService.getOrThrow<string>('DOWNSTREAM_URL');
  const corsOrigins = configService
    .get<string>('CORS_ORIGINS', '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const nodeEnv = configService.get<string>('NODE_ENV', process.env.NODE_ENV || 'development');
  if (nodeEnv === 'production' && corsOrigins.length === 0) {
    throw new Error(
      'Gateway: CORS_ORIGINS must list at least one origin when NODE_ENV=production (credentials are enabled).',
    );
  }

  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // Includes X-App-Version so the PWA can publish its running build to every API call.
    // Idempotency-Key: POST /api/rooms (create room) — required or browsers block preflight.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'accept-language',
      'X-App-Version',
      'Idempotency-Key',
    ],
    // Exposes X-App-Min-Version so the PWA can read it (browsers hide non-simple response
    // headers from JS unless explicitly exposed). Drives the forced-update modal.
    exposedHeaders: ['X-App-Min-Version'],
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  await app.listen(port);

  logger.log(`API Gateway corriendo en puerto ${port}`);
  logger.log(`Seguridad activada (Helmet + Rate Limiting)`);
  logger.log(`REST proxy → ${downstreamUrl}`);
  logger.log(
    `WS proxy  → ${downstreamUrl} (namespaces: /chat /rooms /naval-battle /chess /domino /halma /uno /connect-four)`,
  );
}

bootstrap();

