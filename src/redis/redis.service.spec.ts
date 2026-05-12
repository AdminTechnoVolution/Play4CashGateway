import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { RedisService } from './redis.service';

function makeConfig(prefix = 'accessTokens:'): ConfigService {
  return {
    get: <T>(_k: string, def?: T) => (prefix as unknown as T) ?? def,
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
  });
});
