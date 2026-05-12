import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PROXY_NAMESPACES, WsProxyGateway } from './ws-proxy.gateway';
import type { RedisService } from '../redis/redis.service';

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
  it('proxies every game namespace served by the API (regression: /uno was missing)', () => {
    // If you add a new gateway in the API, also add it here. Catches the silent failure
    // mode where a new game is unreachable from the PWA because the gateway drops it.
    expect(PROXY_NAMESPACES).toEqual(
      expect.arrayContaining(['/chat', '/rooms', '/naval-battle', '/chess', '/domino', '/halma', '/uno']),
    );
  });
});
