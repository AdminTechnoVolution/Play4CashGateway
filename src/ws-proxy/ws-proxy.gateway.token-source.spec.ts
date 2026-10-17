import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsProxyGateway } from './ws-proxy.gateway';
import type { RedisService } from '../redis/redis.service';

/**
 * Socket.IO's polling transport is plain HTTP GET, so a token placed in the
 * query string lands in proxy/CDN access logs and browser history. The
 * gateway must resolve the handshake token from the httpOnly cookie or the
 * `auth` payload (neither touches the URL) — never from `query.token` alone.
 */

const ioMock = jest.fn((_url: string, _opts: Record<string, unknown>) => ({
  on: jest.fn(),
  onAny: jest.fn(),
  emit: jest.fn(),
  disconnect: jest.fn(),
  io: { on: jest.fn(), off: jest.fn() },
  connected: false,
}));

jest.mock('socket.io-client', () => ({
  io: (url: string, opts: Record<string, unknown>) => ioMock(url, opts),
  Socket: class {},
}));

function makeClient(handshake: Record<string, unknown>) {
  return {
    id: 'sid-1',
    handshake: { auth: {}, query: {}, headers: {}, address: '127.0.0.1', ...handshake },
    onAny: jest.fn(),
    offAny: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

function makeConfigService(): ConfigService {
  return {
    get: <T>(_k: string, def?: T) => def,
    getOrThrow: (k: string) => {
      if (k === 'DOWNSTREAM_URL') return 'http://upstream';
      if (k === 'JWT_SECRET') return 'secret';
      return 'value';
    },
  } as unknown as ConfigService;
}

function makeJwt(): JwtService {
  return {
    verifyAsync: jest.fn().mockResolvedValue({ typ: 'access', id: 'player-test' }),
  } as unknown as JwtService;
}

function makeRedis(): RedisService {
  return { isTokenValid: jest.fn().mockResolvedValue(true) } as unknown as RedisService;
}

describe('WsProxyGateway handshake token source', () => {
  beforeEach(() => ioMock.mockClear());

  it('rejects a connection whose only token source is the query string', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient({ query: { token: 'leaked-into-url' } });

    await (gw as any).bridge(client, '/uno', 'http://upstream');

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(ioMock).not.toHaveBeenCalled();
  });

  it('accepts a token supplied via the handshake auth payload', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient({ auth: { token: 'safe-auth-token' } });

    await (gw as any).bridge(client, '/uno', 'http://upstream');

    expect(client.disconnect).not.toHaveBeenCalled();
    expect(ioMock).toHaveBeenCalled();
  });

  it('accepts a token supplied via the httpOnly cookie', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient({ headers: { cookie: 'p4c_access=cookie-token' } });

    await (gw as any).bridge(client, '/uno', 'http://upstream');

    expect(client.disconnect).not.toHaveBeenCalled();
    expect(ioMock).toHaveBeenCalled();
  });
});
