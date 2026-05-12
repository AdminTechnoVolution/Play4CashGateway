import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsProxyGateway } from './ws-proxy.gateway';
import type { RedisService } from '../redis/redis.service';

/**
 * Phase E — periodic token revalidation contract.
 *
 * What we lock in here:
 *  1. The sweeper rejects sessions whose JWT verifyAsync fails (expired, bad sig,
 *     wrong typ) by emitting `auth_expired` and disconnecting after a flush window.
 *  2. The sweeper rejects sessions that Redis no longer recognises (revoked /
 *     logout-elsewhere) the same way.
 *  3. Healthy sessions stay untouched.
 *  4. A transient Redis failure does NOT mass-disconnect users — we conservatively
 *     keep the session for the current tick and let the next sweep retry.
 *  5. A bad entry doesn't break the rest of the sweep (error isolation per session).
 */

function makeConfig(): ConfigService {
  return {
    get: <T>(_k: string, def?: T) => def,
    getOrThrow: (k: string) => {
      if (k === 'JWT_SECRET') return 'secret';
      if (k === 'DOWNSTREAM_URL') return 'http://upstream';
      return 'value';
    },
  } as unknown as ConfigService;
}

function makeFakeClient() {
  return {
    id: 'pwa-sid-1',
    handshake: { auth: {}, query: {}, headers: {}, address: '127.0.0.1' },
    conn: { remoteAddress: '127.0.0.1' },
    emit: jest.fn(),
    disconnect: jest.fn(),
  } as any;
}

function injectSession(gw: WsProxyGateway, id: string, client: any, token: string) {
  // The Map is private; bypassing the access modifier is fine in a unit test.
  (gw as unknown as { sessions: Map<string, { client: any; backendSocket: any; token: string; namespace: string }> }).sessions.set(id, {
    client,
    backendSocket: {} as any,
    token,
    namespace: '/uno',
  });
}

describe('WsProxyGateway revalidation sweeper (Phase E)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('disconnects sessions whose JWT no longer verifies', async () => {
    const jwtService = {
      verifyAsync: jest.fn().mockRejectedValue(new Error('expired')),
    } as unknown as JwtService;
    const redis = { isTokenValid: jest.fn().mockResolvedValue(true) } as unknown as RedisService;
    const gw = new WsProxyGateway(makeConfig(), jwtService, redis);
    const client = makeFakeClient();
    injectSession(gw, 'sid-1', client, 'tok-1');

    await gw.revalidateActiveSessions();

    expect(client.emit).toHaveBeenCalledWith('auth_expired', { reason: 'token_invalid' });
    // Disconnect is debounced 50 ms to flush the auth_expired event over polling.
    expect(client.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects when Redis says the token is no longer in the allowlist', async () => {
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({ typ: 'access' }),
    } as unknown as JwtService;
    const redis = { isTokenValid: jest.fn().mockResolvedValue(false) } as unknown as RedisService;
    const gw = new WsProxyGateway(makeConfig(), jwtService, redis);
    const client = makeFakeClient();
    injectSession(gw, 'sid-1', client, 'tok-revoked');

    await gw.revalidateActiveSessions();

    expect(client.emit).toHaveBeenCalledWith('auth_expired', { reason: 'token_invalid' });
  });

  it('rejects access JWTs that arrive with the wrong typ claim', async () => {
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({ typ: 'refresh' }),
    } as unknown as JwtService;
    const redis = { isTokenValid: jest.fn().mockResolvedValue(true) } as unknown as RedisService;
    const gw = new WsProxyGateway(makeConfig(), jwtService, redis);
    const client = makeFakeClient();
    injectSession(gw, 'sid-1', client, 'tok-refresh');

    await gw.revalidateActiveSessions();

    expect(client.emit).toHaveBeenCalledWith('auth_expired', { reason: 'token_invalid' });
  });

  it('leaves healthy sessions untouched', async () => {
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({ typ: 'access' }),
    } as unknown as JwtService;
    const redis = { isTokenValid: jest.fn().mockResolvedValue(true) } as unknown as RedisService;
    const gw = new WsProxyGateway(makeConfig(), jwtService, redis);
    const client = makeFakeClient();
    injectSession(gw, 'sid-1', client, 'tok-good');

    await gw.revalidateActiveSessions();

    expect(client.emit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('conservatively keeps sessions when Redis throws to avoid flood-disconnects', async () => {
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({ typ: 'access' }),
    } as unknown as JwtService;
    const redis = {
      isTokenValid: jest.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as RedisService;
    const gw = new WsProxyGateway(makeConfig(), jwtService, redis);
    const client = makeFakeClient();
    injectSession(gw, 'sid-1', client, 'tok-good');

    await gw.revalidateActiveSessions();

    expect(client.emit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('isolates failures in one entry from the rest of the sweep', async () => {
    const verifyAsync = jest.fn() as jest.Mock;
    verifyAsync.mockResolvedValueOnce({ typ: 'access' });
    verifyAsync.mockRejectedValueOnce(new Error('expired'));
    const jwtService = { verifyAsync } as unknown as JwtService;
    const redis = { isTokenValid: jest.fn().mockResolvedValue(true) } as unknown as RedisService;
    const gw = new WsProxyGateway(makeConfig(), jwtService, redis);
    const goodClient = makeFakeClient();
    const badClient = makeFakeClient();
    badClient.id = 'pwa-sid-bad';
    injectSession(gw, 'good', goodClient, 'tok-good');
    injectSession(gw, 'bad', badClient, 'tok-bad');

    await gw.revalidateActiveSessions();

    expect(goodClient.emit).not.toHaveBeenCalled();
    expect(badClient.emit).toHaveBeenCalledWith('auth_expired', { reason: 'token_invalid' });
  });
});
