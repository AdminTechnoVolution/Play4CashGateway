import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsProxyGateway } from './ws-proxy.gateway';
import type { RedisService } from '../redis/redis.service';

/**
 * The PWA emits `command_state` + `join` the moment `connect` fires. The gateway
 * accepts the namespace before its token checks finish, so those first events
 * used to arrive with no listener and were silently dropped: no player ever got
 * the start snapshot. These tests lock in that they are held and forwarded.
 */

type Handler = (...args: any[]) => void;

interface FakeBackendSocket {
  on: jest.Mock;
  onAny: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  io: { on: jest.Mock; off: jest.Mock };
  connected: boolean;
  handlers: Map<string, Handler>;
}

let backend: FakeBackendSocket | undefined;
let backendConnected = true;

jest.mock('socket.io-client', () => ({
  io: jest.fn(() => {
    const handlers = new Map<string, Handler>();
    backend = {
      on: jest.fn((event: string, cb: Handler) => { handlers.set(event, cb); }),
      onAny: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
      io: { on: jest.fn(), off: jest.fn() },
      connected: backendConnected,
      handlers,
    };
    return backend;
  }),
  Socket: class {},
}));

function makeClient() {
  const listeners = new Set<Handler>();
  return {
    id: 'pwa-sid-1',
    handshake: { auth: { token: 'tok-1', appVersion: '1.0.0' }, query: {}, headers: {}, address: '127.0.0.1' },
    onAny: jest.fn((cb: Handler) => { listeners.add(cb); }),
    offAny: jest.fn((cb: Handler) => { listeners.delete(cb); }),
    once: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    send(event: string, ...args: unknown[]) { for (const cb of [...listeners]) cb(event, ...args); },
  };
}

function makeConfigService(): ConfigService {
  return {
    get: <T>(_k: string, def?: T) => def,
    getOrThrow: (k: string) => (k === 'DOWNSTREAM_URL' ? 'http://upstream' : 'secret'),
  } as unknown as ConfigService;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('WsProxyGateway events sent before the session is wired', () => {
  beforeEach(() => { backend = undefined; backendConnected = true; });

  it('holds events sent while the token is being checked and forwards them in order', async () => {
    let releaseToken!: () => void;
    const redis = {
      isTokenValid: jest.fn(() => new Promise<boolean>((resolve) => { releaseToken = () => resolve(true); })),
    } as unknown as RedisService;
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ typ: 'access', id: 'p1' }) } as unknown as JwtService;
    const gw = new WsProxyGateway(makeConfigService(), jwt, redis);
    const client = makeClient();

    const bridging = (gw as any).bridge(client, '/connect-four', 'http://upstream');
    client.send('command_state', { roomId: 'r1' });
    client.send('join', { room_id: 'r1' });
    await settle();
    expect(backend).toBeUndefined();

    releaseToken();
    await bridging;
    await settle();
    client.send('get_state', { room_id: 'r1' });
    await settle();

    expect(backend!.emit.mock.calls).toEqual([
      ['command_state', { roomId: 'r1' }],
      ['join', { room_id: 'r1' }],
      ['get_state', { room_id: 'r1' }],
    ]);
    expect(client.offAny).toHaveBeenCalled();
  });

  it('queues start control events until a fresh upstream connects instead of refusing them', async () => {
    backendConnected = false;
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ typ: 'access', id: 'p1' }) } as unknown as JwtService;
    const redis = { isTokenValid: jest.fn().mockResolvedValue(true) } as unknown as RedisService;
    const gw = new WsProxyGateway(makeConfigService(), jwt, redis);
    const client = makeClient();
    await (gw as any).bridge(client, '/uno', 'http://upstream');

    client.send('command_state', { roomId: 'r1' });
    client.send('join', { room_id: 'r1' });
    client.send('initial_state_ack', { roomId: 'r1' });
    client.send('play_card', { room_id: 'r1', card_index: 0 });
    await settle();

    expect(backend!.emit).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('proxy_busy', { event: 'play_card', retryable: true, reason: 'BACKEND_RECOVERING' });
    expect(client.emit).toHaveBeenCalledTimes(1);

    backend!.connected = true;
    backend!.handlers.get('connect')!();
    expect(backend!.emit.mock.calls.map(([event]) => event)).toEqual(['command_state', 'join', 'initial_state_ack']);
  });
});
