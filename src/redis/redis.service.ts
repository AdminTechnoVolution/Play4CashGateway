import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';

@Injectable()
export class RedisService {
  // Short-lived cache for allowlist hits. The API still re-checks auth, so this
  // mainly removes repeated gateway-side Redis round trips on bursts of HTTP calls.
  private readonly tokenValidityCache = new Map<string, number>();

  constructor(
    @Inject('REDIS_CLIENT') private readonly client: Redis,
    private readonly configService: ConfigService,
  ) {}

  async isTokenValid(token: string): Promise<boolean> {
    const cacheTtlMs = this.getTokenValidityCacheTtlMs();
    const now = Date.now();
    if (cacheTtlMs > 0) {
      if (this.tokenValidityCache.size > 2048) {
        this.pruneExpiredTokenCache(now);
      }

      const cachedUntil = this.tokenValidityCache.get(token);
      if (cachedUntil && cachedUntil > now) {
        return true;
      }
      if (cachedUntil) {
        this.tokenValidityCache.delete(token);
      }
    }

    const prefix = this.configService.get<string>(
      'REDIS_TOKEN_PREFIX',
      'accessTokens:',
    );
    const key = `${prefix}${token}`;
    const value = await this.client.get(key);
    if (value !== null && cacheTtlMs > 0) {
      this.tokenValidityCache.set(token, now + cacheTtlMs);
    }
    return value !== null;
  }

  private getTokenValidityCacheTtlMs(): number {
    const raw = this.configService.get<string>('REDIS_TOKEN_CACHE_MS', '15000');
    const ttlMs = Number(raw);
    if (!Number.isFinite(ttlMs) || ttlMs < 0) return 0;
    return Math.trunc(ttlMs);
  }

  private pruneExpiredTokenCache(now: number): void {
    for (const [token, expiresAt] of this.tokenValidityCache.entries()) {
      if (expiresAt > now) continue;
      this.tokenValidityCache.delete(token);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl) {
      await this.client.set(key, value, 'EX', ttl);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}
