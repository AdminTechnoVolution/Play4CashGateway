import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response, NextFunction } from 'express';
import { AuthMiddleware } from './auth.middleware';
import type { RedisService } from '../redis/redis.service';

const SECRET = 'unit-test-secret';
const ISSUER = 'play4cash-api';
const AUDIENCE = 'play4cash-clients';
const ADMIN_SECRET = 'unit-test-admin-secret';

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    JWT_SECRET: SECRET,
    JWT_ISSUER: ISSUER,
    JWT_AUDIENCE: AUDIENCE,
    ADMIN_JWT_SECRET_KEY: ADMIN_SECRET,
    ADMIN_JWT_ISSUER: ISSUER,
    ADMIN_JWT_AUDIENCE: 'play4cash-admin',
    ADMIN_REDIS_ACCESS_PREFIX: 'admin:access:',
    PUBLIC_API_PATHS: '/api/login,/api/health',
    ALLOW_HTTP_TOKEN_QUERY: 'false',
    REDIS_TOKEN_PREFIX: 'accessTokens:',
    ...overrides,
  };
  return {
    get: <T>(k: string, def?: T) => (values[k] as T) ?? def,
    getOrThrow: <T>(k: string) => values[k] as T,
  } as ConfigService;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    path: '/api/something',
    method: 'GET',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

interface MockRes {
  _status: number;
  _body: unknown;
  status(s: number): MockRes;
  json(b: unknown): MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    _status: 0,
    _body: null,
    status(s: number) {
      this._status = s;
      return this;
    },
    json(b: unknown) {
      this._body = b;
      return this;
    },
  };
  return res;
}

function makeJwt(payload?: Record<string, unknown>): JwtService {
  return {
    verifyAsync: jest.fn(async () => payload ?? { id: 'u1', typ: 'access' }),
  } as unknown as JwtService;
}

function makeRedis(valid: boolean): RedisService {
  return { isTokenValid: jest.fn(async () => valid) } as unknown as RedisService;
}

describe('AuthMiddleware (Gateway)', () => {
  it('skips auth for /api/user/public/stats when PUBLIC_API_PATHS falls back to code defaults', async () => {
    const config = {
      get: <T>(k: string, def?: T) =>
        k === 'JWT_SECRET'
          ? (SECRET as T)
          : k === 'JWT_ISSUER'
            ? (ISSUER as T)
            : k === 'JWT_AUDIENCE'
              ? (AUDIENCE as T)
              : k === 'ALLOW_HTTP_TOKEN_QUERY'
                ? ('false' as T)
                : k === 'PUBLIC_API_PATHS'
                  ? (def as T)
                  : def,
      getOrThrow: <T>(k: string) => {
        if (k === 'JWT_SECRET') return SECRET as T;
        throw new Error(`unexpected ${k}`);
      },
    } as ConfigService;
    const mw = new AuthMiddleware(makeJwt(), makeRedis(false), config);
    const next = jest.fn() as NextFunction;
    const res = makeRes();

    await mw.use(
      makeReq({ path: '/api/user/public/stats' }),
      res as unknown as import('express').Response,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(res._status).toBe(0);
  });

  it('skips auth for whitelisted public paths', async () => {
    const mw = new AuthMiddleware(makeJwt(), makeRedis(false), makeConfig());
    const next = jest.fn() as NextFunction;
    const res = makeRes();

    await mw.use(makeReq({ path: '/api/login' }), res as unknown as import('express').Response, next);

    expect(next).toHaveBeenCalled();
    expect(res._status).toBe(0);
  });

  it('always skips admin login bootstrap routes with an older public-path override', async () => {
    const mw = new AuthMiddleware(
      makeJwt(),
      makeRedis(false),
      makeConfig({ PUBLIC_API_PATHS: '/api/login' }),
    );
    const next = jest.fn() as NextFunction;
    const res = makeRes();

    await mw.use(
      makeReq({ method: 'POST', path: '/api/admin/auth/login' }),
      res as unknown as import('express').Response,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(res._status).toBe(0);
  });

  it('skips auth for OPTIONS preflight requests', async () => {
    const mw = new AuthMiddleware(makeJwt(), makeRedis(false), makeConfig());
    const next = jest.fn() as NextFunction;
    const res = makeRes();

    await mw.use(
      makeReq({ method: 'OPTIONS', path: '/api/user/account' }),
      res as unknown as import('express').Response,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(res._status).toBe(0);
  });


  it('accepts a valid token from the access cookie', async () => {
    const mw = new AuthMiddleware(makeJwt(), makeRedis(true), makeConfig());
    const res = makeRes();
    const next = jest.fn();
    const token = 'cookie.jwt.token';

    await mw.use(
      makeReq({ headers: { cookie: `p4c_access=${token}` } }),
      res as unknown as import('express').Response,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(res._status).toBe(0);
  });

  it('returns 401 when no token is provided', async () => {
    const mw = new AuthMiddleware(makeJwt(), makeRedis(true), makeConfig());
    const res = makeRes();

    await mw.use(makeReq(), res as unknown as import('express').Response, jest.fn());

    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ message: 'No token provided' });
  });

  it('returns 401 when token type is not "access"', async () => {
    const mw = new AuthMiddleware(
      makeJwt({ typ: 'refresh' }),
      makeRedis(true),
      makeConfig(),
    );
    const res = makeRes();

    await mw.use(
      makeReq({ headers: { authorization: 'Bearer some.jwt.token' } }),
      res as unknown as Response,
      jest.fn(),
    );

    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ message: 'Invalid token type' });
  });

  it('returns 401 when JWT verification throws', async () => {
    const jwt = {
      verifyAsync: jest.fn().mockRejectedValue(new Error('invalid signature')),
    } as unknown as JwtService;
    const mw = new AuthMiddleware(jwt, makeRedis(true), makeConfig());
    const res = makeRes();

    await mw.use(
      makeReq({ headers: { authorization: 'Bearer xx' } }),
      res as unknown as Response,
      jest.fn(),
    );

    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ message: 'Invalid token' });
  });

  it('returns 401 when Redis says token is revoked', async () => {
    const mw = new AuthMiddleware(makeJwt(), makeRedis(false), makeConfig());
    const res = makeRes();

    await mw.use(
      makeReq({ headers: { authorization: 'Bearer xx' } }),
      res as unknown as Response,
      jest.fn(),
    );

    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ message: 'Token revoked or expired' });
  });

  it('passes a valid Bearer token and attaches req.user', async () => {
    const payload = { id: 'u9', typ: 'access' };
    const mw = new AuthMiddleware(makeJwt(payload), makeRedis(true), makeConfig());
    const res = makeRes();
    const req = makeReq({ headers: { authorization: 'Bearer xx' } });
    const next = jest.fn();

    await mw.use(req, res as unknown as import('express').Response, next);

    expect(next).toHaveBeenCalled();
    expect((req as Request & { user?: unknown }).user).toEqual(payload);
    expect(res._status).toBe(0);
  });

  it('validates admin routes with the isolated secret, audience and Redis prefix', async () => {
    const payload = {
      id: 'admin-1',
      typ: 'access',
      actor_type: 'admin',
      role: 'admin',
    };
    const jwtService = makeJwt(payload);
    const redis = makeRedis(true);
    const mw = new AuthMiddleware(jwtService, redis, makeConfig());
    const res = makeRes();
    const req = makeReq({
      path: '/api/admin/health',
      headers: { cookie: 'p4c_admin_access=admin.jwt.token' },
    });
    const next = jest.fn();

    await mw.use(req, res as unknown as import('express').Response, next);

    expect(jwtService.verifyAsync).toHaveBeenCalledWith(
      'admin.jwt.token',
      expect.objectContaining({
        secret: ADMIN_SECRET,
        audience: 'play4cash-admin',
      }),
    );
    expect(redis.isTokenValid).toHaveBeenCalledWith(
      'admin.jwt.token',
      'admin:access:',
    );
    expect(next).toHaveBeenCalled();
  });

  it('rejects an admin token on player routes', async () => {
    const mw = new AuthMiddleware(
      makeJwt({ typ: 'access', actor_type: 'admin', role: 'admin' }),
      makeRedis(true),
      makeConfig(),
    );
    const res = makeRes();

    await mw.use(
      makeReq({ headers: { authorization: 'Bearer admin.jwt.token' } }),
      res as unknown as Response,
      jest.fn(),
    );

    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ message: 'Invalid token type' });
  });

  it('refuses ?token= when ALLOW_HTTP_TOKEN_QUERY=false', async () => {
    const mw = new AuthMiddleware(
      makeJwt(),
      makeRedis(true),
      makeConfig({ ALLOW_HTTP_TOKEN_QUERY: 'false' }),
    );
    const res = makeRes();

    await mw.use(makeReq({ query: { token: 'xx' } }), res as unknown as import('express').Response, jest.fn());

    expect(res._status).toBe(401);
  });

  it('accepts ?token= when ALLOW_HTTP_TOKEN_QUERY=true', async () => {
    const mw = new AuthMiddleware(
      makeJwt(),
      makeRedis(true),
      makeConfig({ ALLOW_HTTP_TOKEN_QUERY: 'true' }),
    );
    const res = makeRes();
    const next = jest.fn();

    await mw.use(makeReq({ query: { token: 'xx' } }), res as unknown as import('express').Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('strips trailing slash before checking public paths', async () => {
    const mw = new AuthMiddleware(makeJwt(), makeRedis(true), makeConfig());
    const next = jest.fn();
    const res = makeRes();

    await mw.use(makeReq({ path: '/api/login/' }), res as unknown as import('express').Response, next);

    expect(next).toHaveBeenCalled();
    expect(res._status).toBe(0);
  });
});
