import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { RedisService } from '../redis/redis.service';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';

/**
 * Optional HTTP guard (not registered globally). Matches AuthMiddleware rules:
 * JWT iss/aud/typ + Redis allowlist. Prefer middleware for proxied routes.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromRequest(request);

    if (!token) {
      throw new UnauthorizedException('No token provided');
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
        throw new UnauthorizedException('Invalid token type');
      }

      const isValid = await this.redisService.isTokenValid(token);
      if (!isValid) {
        throw new UnauthorizedException('Token revoked or expired');
      }

      (request as Request & { user?: unknown }).user = payload;
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.logger.warn(`Auth failed: ${(error as Error).message}`);
      throw new UnauthorizedException('Invalid token');
    }
  }

  private extractTokenFromRequest(request: Request): string | null {
    const authHeader = request.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    const allowQuery =
      this.configService.get<string>('ALLOW_HTTP_TOKEN_QUERY', 'false').toLowerCase() === 'true';
    if (allowQuery) {
      const token = request.query?.token as string | undefined;
      if (token) return token;
    }

    return null;
  }
}
