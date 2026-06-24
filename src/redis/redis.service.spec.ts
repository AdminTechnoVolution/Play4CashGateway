import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { RedisService } from './redis.service';

function makeConfig(
  prefix = 'accessTokens:',
  overrides: Record<string, unknown> = {},
): ConfigService {
  const values: Record<string, unknown> = {
    REDIS_TOKEN_PREFIX: prefix,
    ...overrides,
  };
  return {
    get: <T>(k: string, def?: T) => (values[k] as T) ?? def,
  } as ConfigService;
}

function makeClient(getImpl: (key: string) => Promise<string | null>): Redis {
  return {
    get: jest.fn(getImpl),
    set: jest.fn(),
    del: jest.fn(),
  } as unknown as Redis;
}

describe('RedisService', () => {
  describe('isTokenValid', () => {
    it('returns true when the prefixed key exists', async () => {
      const client = makeClient(async () => '1');
      const svc = new RedisService(client, makeConfig('accessTokens:'));

      const ok = await svc.isTokenValid('abc');

      expect(ok).toBe(true);
      expect(client.get).toHaveBeenCalledWith('accessTokens:abc');
    });

    it('returns false when the prefixed key is missing', async () => {
      const client = makeClient(async () => null);
      const svc = new RedisService(client, makeConfig('accessTokens:'));

      const ok = await svc.isTokenValid('abc');

      expect(ok).toBe(false);
    });

    it('honors a custom REDIS_TOKEN_PREFIX', async () => {
      const client = makeClient(async () => 'x');
      const svc = new RedisService(client, makeConfig('foo:'));

      await svc.isTokenValid('z');

      expect(client.get).toHaveBeenCalledWith('foo:z');
    });

    it('caches positive lookups briefly to avoid repeated Redis reads', async () => {
      jest.useFakeTimers();
      try {
        const client = makeClient(async () => '1');
        const svc = new RedisService(
          client,
          makeConfig('accessTokens:', { REDIS_TOKEN_CACHE_MS: '1000' }),
        );

        await svc.isTokenValid('abc');
        await svc.isTokenValid('abc');

        expect(client.get).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('refreshes the cache after the TTL expires', async () => {
      jest.useFakeTimers();
      try {
        const client = makeClient(async () => '1');
        const svc = new RedisService(
          client,
          makeConfig('accessTokens:', { REDIS_TOKEN_CACHE_MS: '1000' }),
        );

        await svc.isTokenValid('abc');
        jest.advanceTimersByTime(1001);
        await svc.isTokenValid('abc');

        expect(client.get).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
