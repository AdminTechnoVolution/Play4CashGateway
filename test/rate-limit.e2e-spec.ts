import { Controller, Get, Module, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Redis } from 'ioredis';
import {
  createGatewayRateLimitMiddleware,
  resolveGatewayRateLimitConfig,
} from '../src/common/rate-limit/gateway-rate-limit';

@Controller()
class EchoController {
  @Get('echo')
  echo(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  controllers: [EchoController],
})
class EchoModule {}

function makeRedisMock(): Redis {
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  return {
    eval: jest.fn(async (_script: string, numkeys: number, key: string, windowMs: string) => {
      if (numkeys !== 1) throw new Error('unexpected numkeys');
      const ttl = Number(windowMs);
      const now = Date.now();
      const current = buckets.get(key) ?? { count: 0, expiresAt: now + ttl };
      if (current.expiresAt <= now) {
        current.count = 0;
        current.expiresAt = now + ttl;
      }
      current.count += 1;
      buckets.set(key, current);
      return [current.count, Math.max(1, current.expiresAt - now)];
    }),
    get: jest.fn(async () => null),
    del: jest.fn(async () => 1),
    pttl: jest.fn(async () => -1),
    set: jest.fn(async () => 'OK'),
    keys: jest.fn(async () => []),
  } as unknown as Redis;
}

describe('Gateway rate limiting', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  async function buildApp(redis: Redis, windowMs = 60_000, max = 2): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [EchoModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.set('trust proxy', 1);
    const cfg = resolveGatewayRateLimitConfig(windowMs, max);
    app.use(
      createGatewayRateLimitMiddleware({
        redis,
        windowMs: cfg.windowMs,
        max: cfg.max,
      }),
    );
    await app.init();
    return app;
  }

  it('returns 429 after the same forwarded IP exceeds the quota', async () => {
    const redis = makeRedisMock();
    await buildApp(redis, 60_000, 2);
    const httpServer = app.getHttpServer();

    const first = await request(httpServer)
      .get('/echo')
      .set('X-Forwarded-For', '203.0.113.10');
    const second = await request(httpServer)
      .get('/echo')
      .set('X-Forwarded-For', '203.0.113.10');
    const third = await request(httpServer)
      .get('/echo')
      .set('X-Forwarded-For', '203.0.113.10');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.body.statusCode).toBe(429);
  });

  it('counts different IPs separately', async () => {
    const redis = makeRedisMock();
    await buildApp(redis, 60_000, 1);
    const httpServer = app.getHttpServer();

    const ipA = await request(httpServer).get('/echo').set('X-Forwarded-For', '203.0.113.10');
    const ipB = await request(httpServer).get('/echo').set('X-Forwarded-For', '203.0.113.11');

    expect(ipA.status).toBe(200);
    expect(ipB.status).toBe(200);
  });
});
