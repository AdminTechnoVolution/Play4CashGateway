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
        proxyReq: (proxyReq, req) => {
          const user = (req as Request & { user?: unknown }).user;
          if (user) {
            proxyReq.setHeader('x-gateway-user', JSON.stringify(user));
          }
          this.logger.debug(`Proxying ${req.method} ${req.url} → ${downstreamUrl}`);
        },
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
    this.proxy(req, res, next);
  }
}
