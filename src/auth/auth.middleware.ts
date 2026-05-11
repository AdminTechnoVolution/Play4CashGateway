import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { RedisService } from '../redis/redis.service';

/**
 * Comma-separated paths (exact match, no querystring) that skip JWT at the gateway.
 * Must stay aligned with @Public() on the downstream API.
 */
const DEFAULT_PUBLIC_PATHS =
  '/api/login,/api/login/refresh,/api/login/invalidate-browser-session,/api/user/register,/api/user/verify-code,/api/rooms/stats';

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthMiddleware.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const path = this.normalizePath(req.path.split('?')[0]);

    if (this.isPublicPath(path)) {
      return next();
    }

    const token = this.extractToken(req);

    if (!token) {
      this.recordAuthFailure(req, 'missing_token');
      res.status(401).json({ statusCode: 401, message: 'No token provided' });
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
        return;
      }

      const isValid = await this.redisService.isTokenValid(token);
      if (!isValid) {
        this.recordAuthFailure(req, 'token_revoked');
        res.status(401).json({ statusCode: 401, message: 'Token revoked or expired' });
        return;
      }

      (req as Request & { user?: unknown }).user = payload;
      next();
    } catch {
      this.recordAuthFailure(req, 'jwt_invalid');
      res.status(401).json({ statusCode: 401, message: 'Invalid token' });
    }
  }

  /**
   * Structured log line for observability dashboards (Loki/CloudWatch/Datadog).
   * Never logs token bytes; only the failure reason and request shape.
   */
  private recordAuthFailure(req: Request, reason: string): void {
    const ip = (req.ip || req.socket?.remoteAddress || 'unknown').toString();
    this.logger.warn(
      `event=auth_failure reason=${reason} method=${req.method} path=${req.path} ip=${ip}`,
    );
  }

  private normalizePath(path: string): string {
    if (path.length > 1 && path.endsWith('/')) {
      return path.replace(/\/+$/, '');
    }
    return path;
  }

  private isPublicPath(path: string): boolean {
    const raw = this.configService.get<string>('PUBLIC_API_PATHS', DEFAULT_PUBLIC_PATHS);
    const set = new Set(
      raw
        .split(',')
        .map((s) => this.normalizePath(s.trim()))
        .filter(Boolean),
    );
    return set.has(path);
  }

  private extractToken(req: Request): string | null {
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
}
