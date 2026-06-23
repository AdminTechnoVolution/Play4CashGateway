import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ConnectFourEdgeGateway } from './connect-four-edge.gateway';
import { PROXY_NAMESPACES, WsProxyGateway, buildUpstreamHandshake } from './ws-proxy.gateway';
import type { RedisService } from '../redis/redis.service';
import type { Socket } from 'socket.io';

/**
 * `passesVersionGate` and `readClientVersion` are private. We exercise them via the public
 * surface by reaching for them through casting; this is a unit test only.
 */
interface VersionGateAccess {
  passesVersionGate(client: unknown, namespace: string): boolean;
}

function makeConfig(min = ''): ConfigService {
  return { get: <T>(_k: string, def?: T) => (min as unknown as T) ?? def } as ConfigService;
}

function makeClient(handshake: Record<string, unknown>) {
  const emit = jest.fn();
  const disconnect = jest.fn();
  return {
    handshake: { auth: {}, query: {}, headers: {}, address: '127.0.0.1', ...handshake },
    id: 'sid-1',
    conn: { remoteAddress: '127.0.0.1' },
    emit,
    disconnect,
  };
}

function makeGateway(min = ''): VersionGateAccess {
  const gw = new WsProxyGateway(
    makeConfig(min),
    {} as JwtService,
    {} as RedisService,
  );
  return gw as unknown as VersionGateAccess;
}

describe('WsProxyGateway version gate', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('passes when PWA_MIN_VERSION is empty', () => {
    const gw = makeGateway('');
    const client = makeClient({ auth: { appVersion: '0.0.1' } });

    expect(gw.passesVersionGate(client, '/chess')).toBe(true);
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('passes when client appVersion >= min', () => {
    const gw = makeGateway('1.0.0');
    const client = makeClient({ auth: { appVersion: '1.0.0' } });

    expect(gw.passesVersionGate(client, '/chess')).toBe(true);
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('rejects when client appVersion < min and emits version_mismatch', () => {
    const gw = makeGateway('2.0.0');
    const client = makeClient({ auth: { appVersion: '1.0.0' } });

    expect(gw.passesVersionGate(client, '/chess')).toBe(false);
    expect(client.emit).toHaveBeenCalledWith('version_mismatch', { requiredVersion: '2.0.0' });

    // Disconnect is debounced 50ms to flush the event over the wire.
    expect(client.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('reads version from query string when auth is missing', () => {
    const gw = makeGateway('1.0.0');
    const client = makeClient({ query: { appVersion: '1.5.0' } });

    expect(gw.passesVersionGate(client, '/chess')).toBe(true);
  });

  it('reads version from X-App-Version header (lowercase) when auth + query missing', () => {
    const gw = makeGateway('1.0.0');
    const client = makeClient({ headers: { 'x-app-version': '1.5.0' } });

    expect(gw.passesVersionGate(client, '/chess')).toBe(true);
  });

  it('rejects when no version is supplied at all', () => {
    const gw = makeGateway('1.0.0');
    const client = makeClient({});

    expect(gw.passesVersionGate(client, '/chess')).toBe(false);
    expect(client.emit).toHaveBeenCalledWith('version_mismatch', { requiredVersion: '1.0.0' });
  });
});

describe('WsProxyGateway namespace registry', () => {
  it('proxies legacy namespaces that still use the downstream Socket.IO bridge', () => {
    expect(PROXY_NAMESPACES).toEqual(
      expect.arrayContaining([
        '/chat',
        '/rooms',
        '/naval-battle',
        '/chess',
        '/domino',
        '/halma',
        '/uno',
        '/tournaments',
      ]),
    );
  });

  it('keeps connect-four out of the downstream bridge because it has a Redis Streams edge', () => {
    expect(PROXY_NAMESPACES).not.toContain('/connect-four');
    expect(ConnectFourEdgeGateway).toBeDefined();
  });
});

function makeHandshakeSocket(partial: {
  auth?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}): Socket {
  return {
    handshake: {
      auth: partial.auth ?? {},
      query: partial.query ?? {},
      headers: partial.headers ?? {},
    },
  } as Socket;
}

describe('buildUpstreamHandshake', () => {
  it('copies token and forwards allowed lang + appVersion on auth and query', () => {
    const client = makeHandshakeSocket({
      auth: { lang: 'es', appVersion: '1.2.3' },
      query: { foo: 'bar' },
    });
    const { auth, query } = buildUpstreamHandshake(client, 'jwt-token');
    expect(auth).toEqual({ token: 'jwt-token', lang: 'es', appVersion: '1.2.3' });
    expect(query).toEqual({ token: 'jwt-token', lang: 'es', appVersion: '1.2.3' });
  });

  it('reads lang from query when auth omits it', () => {
    const client = makeHandshakeSocket({
      query: { lang: 'fr', token: 'ignored-here' },
    });
    const { auth } = buildUpstreamHandshake(client, 't');
    expect(auth.lang).toBe('fr');
  });

  it('ignores unsupported lang values', () => {
    const client = makeHandshakeSocket({
      auth: { lang: 'xx' },
    });
    const { auth } = buildUpstreamHandshake(client, 't');
    expect(auth.lang).toBeUndefined();
    expect(auth.token).toBe('t');
  });

  it('reads appVersion from X-App-Version header when absent from auth/query', () => {
    const client = makeHandshakeSocket({
      headers: { 'x-app-version': '2.0.0' },
    });
    const { query } = buildUpstreamHandshake(client, 't');
    expect(query.appVersion).toBe('2.0.0');
  });
});
