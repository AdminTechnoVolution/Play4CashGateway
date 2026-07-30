import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';

@Injectable()
export class RedisService {
  // Short-lived cache for allowlist hits. The API still re-checks auth, so this
  // mainly removes repeated gateway-side Redis round trips on bursts of HTTP calls.
  private readonly tokenValidityCache = new Map<string, number>();
  private readonly pendingTokenChecks = new Map<string, Promise<boolean>>();

  constructor(
    @Inject('REDIS_CLIENT') private readonly client: Redis,
    private readonly configService: ConfigService,
  ) {}

  async isTokenValid(token: string, prefixOverride?: string): Promise<boolean> {
    const cacheKey = `${prefixOverride || ''}\u0000${token}`;
    const cacheTtlMs = this.getTokenValidityCacheTtlMs();
    const now = Date.now();
    if (cacheTtlMs > 0) {
      if (this.tokenValidityCache.size > 2048) {
        this.pruneExpiredTokenCache(now);
      }

      const cachedUntil = this.tokenValidityCache.get(cacheKey);
      if (cachedUntil && cachedUntil > now) {
        return true;
      }
      if (cachedUntil) {
        this.tokenValidityCache.delete(cacheKey);
      }
    }

    const pending = this.pendingTokenChecks.get(cacheKey);
    if (pending) {
      return pending;
    }

    const lookup = this.lookupTokenValidity(token, cacheKey, cacheTtlMs, now, prefixOverride);
    this.pendingTokenChecks.set(cacheKey, lookup);
    try {
      return await lookup;
    } finally {
      this.pendingTokenChecks.delete(cacheKey);
    }
  }

  primeTokenValidity(token: string, ttlMs?: number): void {
    const effectiveTtl = this.getTokenValidityCacheTtlMs();
    const cacheTtlMs = Math.max(1, Math.trunc(ttlMs ?? effectiveTtl));
    if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) return;
    this.pendingTokenChecks.delete(token);
    this.tokenValidityCache.set(token, Date.now() + cacheTtlMs);
  }

  private async lookupTokenValidity(
    token: string,
    cacheKey: string,
    cacheTtlMs: number,
    now: number,
    prefixOverride?: string,
  ): Promise<boolean> {
    const prefix = prefixOverride || this.configService.get<string>(
      'REDIS_TOKEN_PREFIX',
      'accessTokens:',
    );
    const key = `${prefix}${token}`;
    const value = await this.client.get(key);
    if (value !== null && cacheTtlMs > 0) {
      this.tokenValidityCache.set(cacheKey, now + cacheTtlMs);
    }
    return value !== null;
  }

  private getTokenValidityCacheTtlMs(): number {
    const raw = this.configService.get<string>('REDIS_TOKEN_CACHE_MS', '60000');
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
