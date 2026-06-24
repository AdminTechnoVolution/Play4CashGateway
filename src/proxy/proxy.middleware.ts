import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { IncomingMessage, ServerResponse } from 'http';

type ProxyHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void;

@Injectable()
export class ProxyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ProxyMiddleware.name);
  private readonly proxy: ProxyHandler;

  constructor(private readonly configService: ConfigService) {
    const downstreamUrl = this.configService.getOrThrow<string>('DOWNSTREAM_URL');

    const middleware = createProxyMiddleware<IncomingMessage, ServerResponse>({
      target: downstreamUrl,
      changeOrigin: true,
      ws: true,
      on: {
        error: (err, _req, res) => {
          this.logger.error(`Proxy error: ${(err as Error).message}`);
          const serverRes = res as ServerResponse;
          if (!serverRes.headersSent) {
            serverRes.writeHead(502, { 'Content-Type': 'application/json' });
            serverRes.end(
              JSON.stringify({ statusCode: 502, message: 'Bad Gateway — downstream unavailable' }),
            );
          }
        },
      },
    });

    this.proxy = middleware as unknown as ProxyHandler;
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    const trustHeader =
      this.configService.get<string>('GATEWAY_TRUST_HEADER_NAME') || 'x-gateway-internal';
    const headerKey = trustHeader.toLowerCase();
    const internalSecret = this.configService.get<string>('GATEWAY_INTERNAL_SECRET');
    delete (req.headers as Record<string, unknown>)[headerKey];

    const user = (req as Request & { user?: unknown }).user;
    if (user) {
      delete (req.headers as Record<string, unknown>)['x-gateway-user'];
      req.headers['x-gateway-user'] = JSON.stringify(user);
    }
    // Every proxied request (including public routes) gets the trust header so the API can reject spoofed x-gateway-user.
    if (internalSecret) {
      req.headers[headerKey] = internalSecret;
    }

    const thresholdMs = this.getSlowProxyThresholdMs();
    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      if (elapsedMs < thresholdMs) return;
      this.logger.warn(
        `event=proxy_slow method=${req.method} path=${req.originalUrl || req.url} status=${res.statusCode} duration_ms=${elapsedMs.toFixed(1)} target=${this.configService.get('DOWNSTREAM_URL')}`,
      );
    });

    this.logger.debug(`Proxying ${req.method} ${req.url} → ${this.configService.get('DOWNSTREAM_URL')}`);
    this.proxy(req, res, next);
  }

  private getSlowProxyThresholdMs(): number {
    const raw = this.configService.get<string>('GATEWAY_PROXY_SLOW_MS', '100');
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return 100;
    return parsed;
  }
}
