import { Logger } from '@nestjs/common';
import type { RequestHandler } from 'express';
import {
  ipKeyGenerator,
  rateLimit,
  type ClientRateLimitInfo,
  type Options,
  type Store,
} from 'express-rate-limit';
import type Redis from 'ioredis';

export interface GatewayRateLimitConfig {
  windowMs: number;
  max: number;
}

export interface GatewayRateLimitMiddlewareOptions extends GatewayRateLimitConfig {
  redis: Redis;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 50;
const STORE_PREFIX = 'gateway:rate-limit:';
const FAIL_CLOSED_HITS = Number.MAX_SAFE_INTEGER;

export function resolveGatewayRateLimitConfig(windowMs: unknown, max: unknown): GatewayRateLimitConfig {
  return {
    windowMs: parsePositiveInt(windowMs, DEFAULT_WINDOW_MS),
    max: parsePositiveInt(max, DEFAULT_MAX),
  };
}

export function createGatewayRateLimitMiddleware(options: GatewayRateLimitMiddlewareOptions): RequestHandler {
  const store = new RedisRateLimitStore(options.redis);
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: false,
    message: {
      statusCode: 429,
      message: 'Demasiadas peticiones. Por favor, intenta de nuevo más tarde.',
    },
    keyGenerator: (request) =>
      ipKeyGenerator(request.ip || request.socket?.remoteAddress || 'unknown', false),
    store,
  });
}

class RedisRateLimitStore implements Store {
  public readonly localKeys = false;
  public readonly prefix = STORE_PREFIX;
  private readonly logger = new Logger('GatewayRateLimitStore');

  private windowMs = DEFAULT_WINDOW_MS;

  constructor(private readonly redis: Redis) {}

  init(options: Options): void {
    this.windowMs = parsePositiveInt(options.windowMs, DEFAULT_WINDOW_MS);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const redisKey = `${this.prefix}${key}`;
    const startedAt = process.hrtime.bigint();
    try {
      const result = (await this.redis.eval(
        `
          local current = redis.call('INCR', KEYS[1])
          if current == 1 then
            redis.call('PEXPIRE', KEYS[1], ARGV[1])
          end
          local ttl = redis.call('PTTL', KEYS[1])
          if ttl < 0 then
            redis.call('PEXPIRE', KEYS[1], ARGV[1])
            ttl = ARGV[1]
          end
          return { current, ttl }
        `,
        1,
        redisKey,
        String(this.windowMs),
      )) as [number | string, number | string];

      const totalHits = parsePositiveInt(result?.[0], FAIL_CLOSED_HITS);
      const ttlMs = parsePositiveInt(result?.[1], this.windowMs);
      this.logSlowEval('increment', redisKey, startedAt);
      return {
        totalHits,
        resetTime: new Date(Date.now() + ttlMs),
      };
    } catch (error) {
      console.error('[GatewayRateLimitStore] Redis increment failed, blocking request', error);
      return {
        totalHits: FAIL_CLOSED_HITS,
        resetTime: new Date(Date.now() + this.windowMs),
      };
    }
  }

  async decrement(key: string): Promise<void> {
    const redisKey = `${this.prefix}${key}`;
    const startedAt = process.hrtime.bigint();
    try {
      const current = parsePositiveInt(await this.redis.get(redisKey), 0);
      if (current <= 1) {
        await this.redis.del(redisKey);
        this.logSlowEval('decrement', redisKey, startedAt);
        return;
      }

      const ttlMs = await this.redis.pttl(redisKey);
      const nextValue = String(current - 1);
      if (ttlMs > 0) {
        await this.redis.set(redisKey, nextValue, 'PX', ttlMs);
      } else {
        await this.redis.set(redisKey, nextValue, 'PX', this.windowMs);
      }
      this.logSlowEval('decrement', redisKey, startedAt);
    } catch (error) {
      console.error('[GatewayRateLimitStore] Redis decrement failed', error);
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await this.redis.del(`${this.prefix}${key}`);
    } catch (error) {
      console.error('[GatewayRateLimitStore] Redis resetKey failed', error);
    }
  }

  async resetAll(): Promise<void> {
    try {
      const keys = await this.redis.keys(`${this.prefix}*`);
      if (keys.length > 0) await this.redis.del(...keys);
    } catch (error) {
      console.error('[GatewayRateLimitStore] Redis resetAll failed', error);
    }
  }

  async shutdown(): Promise<void> {
    return;
  }

  private logSlowEval(operation: string, key: string, startedAt: bigint): void {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const thresholdMs = this.getSlowRateLimitThresholdMs();
    if (elapsedMs < thresholdMs) return;
    this.logger.warn(
      `event=rate_limit_slow op=${operation} key=${key} duration_ms=${elapsedMs.toFixed(1)}`,
    );
  }

  private getSlowRateLimitThresholdMs(): number {
    const raw = process.env.GATEWAY_RATE_LIMIT_SLOW_MS ?? '20';
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return 20;
    return parsed;
  }
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}
