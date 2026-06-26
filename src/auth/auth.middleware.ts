import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { RedisService } from '../redis/redis.service';
import { createRequestId, getCurrentRequestId } from '../common/request-context';
import { normalizeGatewayPath } from '../common/http-path.util';

const ACCESS_COOKIE_NAME = 'p4c_access';

/**
 * Comma-separated paths (exact match, no querystring) that skip JWT at the gateway.
 * Must stay aligned with @Public() on the downstream API.
 */
const DEFAULT_PUBLIC_PATHS =
  '/api/login,/api/login/refresh,/api/login/invalidate-browser-session,/api/user/register,/api/user/verify-code,/api/user/public/stats,/api/rooms/stats';

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthMiddleware.name);
  private publicPathSet: Set<string> | null = null;

  constructor(
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const startedAt = process.hrtime.bigint();
    const path = normalizeGatewayPath(req.path);
    const requestId = createRequestId(req.headers['x-request-id']);
    req.headers['x-request-id'] = requestId;
    if (typeof res.setHeader === 'function') {
      res.setHeader('x-request-id', requestId);
    }

    if (req.method === 'OPTIONS') {
      this.logSlowAuth(req, path, startedAt, 'options_skip');
      return next();
    }

    if (this.isPublicPath(path)) {
      this.logSlowAuth(req, path, startedAt, 'public_skip');
      return next();
    }

    const token = this.extractToken(req);

    if (!token) {
      this.recordAuthFailure(req, 'missing_token');
      res.status(401).json({ statusCode: 401, message: 'No token provided' });
      this.logSlowAuth(req, path, startedAt, 'missing_token');
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
        this.recordAuthFailure(req, 'wrong_typ');
        res.status(401).json({ statusCode: 401, message: 'Invalid token type' });
        this.logSlowAuth(req, path, startedAt, 'wrong_typ');
        return;
      }

      const isValid = await this.redisService.isTokenValid(token);
      if (!isValid) {
        this.recordAuthFailure(req, 'token_revoked');
        res.status(401).json({ statusCode: 401, message: 'Token revoked or expired' });
        this.logSlowAuth(req, path, startedAt, 'token_revoked');
        return;
      }

      (req as Request & { user?: unknown }).user = payload;
      this.logSlowAuth(req, path, startedAt, 'ok');
      next();
    } catch {
      this.recordAuthFailure(req, 'jwt_invalid');
      res.status(401).json({ statusCode: 401, message: 'Invalid token' });
      this.logSlowAuth(req, path, startedAt, 'jwt_invalid');
    }
  }

  private recordAuthFailure(req: Request, reason: string): void {
    const ip = (req.ip || req.socket?.remoteAddress || 'unknown').toString();
    this.logger.warn(
      `event=auth_failure reqId=${getCurrentRequestId() ?? 'n/a'} reason=${reason} method=${req.method} path=${req.path} ip=${ip}`,
    );
  }

  private isPublicPath(path: string): boolean {
    if (!this.publicPathSet) {
      const raw = this.configService.get<string>('PUBLIC_API_PATHS', DEFAULT_PUBLIC_PATHS);
      this.publicPathSet = new Set(
        raw
          .split(',')
          .map((s) => normalizeGatewayPath(s))
          .filter(Boolean),
      );
    }

    return this.publicPathSet.has(path);
  }

  private extractToken(req: Request): string | null {
    const cookieToken = readCookie(req.headers.cookie, ACCESS_COOKIE_NAME);
    if (cookieToken) return cookieToken;

    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);

    const allowQuery =
      this.configService.get<string>('ALLOW_HTTP_TOKEN_QUERY', 'false').toLowerCase() === 'true';
    if (allowQuery) {
      const token = req.query?.token as string | undefined;
      if (token) return token;
    }

    return null;
  }

  private logSlowAuth(req: Request, path: string, startedAt: bigint, outcome: string): void {
    const thresholdMs = this.getSlowAuthThresholdMs();
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (elapsedMs < thresholdMs) return;

    this.logger.warn(
      `event=auth_slow reqId=${getCurrentRequestId() ?? 'n/a'} outcome=${outcome} method=${req.method} path=${path} duration_ms=${elapsedMs.toFixed(1)}`,
    );
  }

  private getSlowAuthThresholdMs(): number {
    const raw = this.configService.get<string>('GATEWAY_AUTH_SLOW_MS', '25');
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return 25;
    return parsed;
  }
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
