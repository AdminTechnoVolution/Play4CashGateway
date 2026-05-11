import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // bodyParser deshabilitado: el gateway proxia streams REST sin parsear bodies.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const configService = app.get(ConfigService);

  // Configuración de Seguridad (Helmet)
  app.use(helmet());

  // Configuración de Rate Limiting
  const limiter = rateLimit({
    windowMs: Number(configService.get<number>('RATE_LIMIT_WINDOW_MS', 60000)),
    max: Number(configService.get<number>('RATE_LIMIT_MAX', 100)),
    standardHeaders: true, // Retorna cabeceras RateLimit-*
    legacyHeaders: false, // Deshabilita cabeceras X-RateLimit-* antiguas
    message: {
      statusCode: 429,
      message: 'Demasiadas peticiones. Por favor, intenta de nuevo más tarde.',
    },
  });
  app.use(limiter);

  // Confiar en el proxy (necesario si hay un Load Balancer/Ingress como Nginx adelante)
  // para que express-rate-limit detecte correctamente la IP del cliente.
  app.set('trust proxy', 1);

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
    allowedHeaders: ['Content-Type', 'Authorization', 'accept-language'],
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  await app.listen(port);

  logger.log(`API Gateway corriendo en puerto ${port}`);
  logger.log(`Seguridad activada (Helmet + Rate Limiting)`);
  logger.log(`REST proxy → ${downstreamUrl}`);
  logger.log(`WS proxy  → ${downstreamUrl} (namespaces: /chat /rooms /naval-battle /chess /domino /halma)`);
}

bootstrap();

