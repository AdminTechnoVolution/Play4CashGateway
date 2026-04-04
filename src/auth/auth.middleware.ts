import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { RedisService } from '../redis/redis.service';

// Rutas que NO requieren token
const PUBLIC_PATHS = [
  '/api/login',
  '/api/login/refresh',
];

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthMiddleware.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const path = req.path.split('?')[0];
    const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

    if (isPublic) {
      return next();
    }

    const token = this.extractToken(req);

    if (!token) {
      res.status(401).json({ statusCode: 401, message: 'No token provided' });
      return;
    }

    try {
      const secret = this.configService.getOrThrow<string>('JWT_SECRET');
      const payload = await this.jwtService.verifyAsync(token, { secret });

      const isValid = await this.redisService.isTokenValid(token);
      if (!isValid) {
        res.status(401).json({ statusCode: 401, message: 'Token revoked or expired' });
        return;
      }

      (req as any).user = payload;
      next();
    } catch {
      res.status(401).json({ statusCode: 401, message: 'Invalid token' });
    }
  }

  private extractToken(req: Request): string | null {
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);

    const token = req.query?.token as string | undefined;
    if (token) return token;

    return null;
  }
}
