import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import { createRequestId, runWithRequestContext } from './common/request-context';
import { parsePathSet, shouldSkipGatewayRateLimit } from './common/http-path.util';
import {
  createGatewayRateLimitMiddleware,
  resolveGatewayRateLimitConfig,
} from './common/rate-limit/gateway-rate-limit';

const DEFAULT_PUBLIC_API_PATHS =
  '/api/login,/api/login/refresh,/api/login/invalidate-browser-session,/api/user/register,/api/user/verify-code,/api/user/public/stats,/api/rooms/stats';
const DEFAULT_RATE_LIMIT_SKIP_PATHS =
  '/api/login,/api/user/register,/api/user/verify-code,/api/user/public/stats,/api/user/account,/api/games,/api/tournaments,/api/tournaments/mine,/api/rooms/active,/api/rooms/game,/api/user/history,/api/transactions/recharge/history,/api/transactions/withdrawal/history';

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
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = createRequestId(req.headers['x-request-id']);
    req.headers['x-request-id'] = requestId;
    if (typeof res.setHeader === 'function') {
      res.setHeader('x-request-id', requestId);
    }
    runWithRequestContext(requestId, () => next());
  });
  app.use(helmet());

  const slowHttpMs = resolveSlowHttpThreshold(
    configService.get<string>('GATEWAY_HTTP_SLOW_MS'),
  );
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startedAt = process.hrtime.bigint();
    const requestId = String(req.headers['x-request-id'] || 'n/a');
    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      if (elapsedMs < slowHttpMs) return;
      logger.warn(
        `event=http_slow reqId=${requestId} method=${req.method} path=${req.originalUrl || req.url} status=${res.statusCode} duration_ms=${elapsedMs.toFixed(1)}`,
      );
    });
    next();
  });

  // Configuración de Rate Limiting
  const limiter = createGatewayRateLimitMiddleware({
    redis: redisClient,
    windowMs: rateLimitConfig.windowMs,
    max: rateLimitConfig.max,
  });
  // Rate limiting stays on for public routes by default; only OPTIONS and an
  // explicit skip list are excluded.
  const configuredRateLimitSkipPaths = configService.get<string>('RATE_LIMIT_SKIP_PATHS');
  const rateLimitSkipPaths = parsePathSet(
    configuredRateLimitSkipPaths?.trim() ? configuredRateLimitSkipPaths : DEFAULT_RATE_LIMIT_SKIP_PATHS,
  );
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (shouldSkipGatewayRateLimit(req.method, req.originalUrl || req.url, rateLimitSkipPaths)) {
      return next();
    }
    return limiter(req, res, next);
  });

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

function resolveSlowHttpThreshold(raw: string | undefined): number {
  const parsed = Number(raw ?? '250');
  if (!Number.isFinite(parsed) || parsed < 0) return 250;
  return parsed;
}

bootstrap();
