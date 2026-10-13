import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsProxyGateway } from './ws-proxy.gateway';
import type { RedisService } from '../redis/redis.service';
import type { WsRateLimiterService } from '../common/rate-limit/ws-rate-limiter.service';

/**
 * The inbound `client.onAny` forwarder used to relay every event to the
 * downstream API with no throttling — a single session could flood the
 * backend/Redis with game-action events. This locks in the fix: a rejected
 * event is dropped (not forwarded) and the client is told, while an allowed
 * event still reaches the backend in order.
 */

type Handler = (...args: any[]) => void;

interface FakeClient {
  id: string;
  handshake: any;
  onAny: jest.Mock;
  once: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  __fire(event: string, ...args: unknown[]): void;
}

interface FakeBackendSocket {
  on: jest.Mock;
  onAny: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  io: { on: jest.Mock; off: jest.Mock };
  connected: boolean;
}

let lastBackendSocket: FakeBackendSocket | undefined;

jest.mock('socket.io-client', () => {
  return {
    io: jest.fn(() => {
      const socket: FakeBackendSocket = {
        on: jest.fn(),
        onAny: jest.fn(),
        emit: jest.fn(),
        disconnect: jest.fn(),
        io: { on: jest.fn(), off: jest.fn() },
        connected: true,
      };
      lastBackendSocket = socket;
      return socket;
    }),
    Socket: class {},
  };
});

function makeClient(): FakeClient {
  const clientHandlers = new Map<string, Handler>();
  let onAnyCb: Handler | null = null;
  return {
    id: 'pwa-sid-1',
    handshake: {
      auth: { token: 'tok-1', appVersion: '1.0.0' },
      query: { token: 'tok-1' },
      headers: {},
      address: '127.0.0.1',
    },
    onAny: jest.fn((cb: Handler) => {
      onAnyCb = cb;
    }),
    once: jest.fn((event: string, cb: Handler) => {
      clientHandlers.set(event, cb);
    }),
    emit: jest.fn(),
    disconnect: jest.fn(),
    __fire(event, ...args) {
      if (event === '__onAny') {
        onAnyCb?.(...args);
        return;
      }
      clientHandlers.get(event)?.(...args);
    },
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

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('WsProxyGateway inbound event rate limiting', () => {
  beforeEach(() => {
    lastBackendSocket = undefined;
  });

  it('drops the event and notifies the client when the limiter rejects it', async () => {
    const rateLimiter = { allow: jest.fn().mockResolvedValue(false) } as unknown as WsRateLimiterService;
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis(), rateLimiter);
    const client = makeClient();
    await (gw as any).bridge(client, '/domino', 'http://upstream');

    client.__fire('__onAny', 'drop_disc', { room_id: 'room-1', col: 3 });
    await flushMicrotasks();

    expect(rateLimiter.allow).toHaveBeenCalledWith(
      '/domino:player-test',
      expect.any(Number),
      expect.any(Number),
    );
    expect(lastBackendSocket!.emit).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('rate_limited', { event: 'drop_disc' });
  });

  it('forwards the event when the limiter allows it', async () => {
    const rateLimiter = { allow: jest.fn().mockResolvedValue(true) } as unknown as WsRateLimiterService;
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis(), rateLimiter);
    const client = makeClient();
    await (gw as any).bridge(client, '/domino', 'http://upstream');

    client.__fire('__onAny', 'drop_disc', { room_id: 'room-1', col: 3 });
    await flushMicrotasks();

    expect(lastBackendSocket!.emit).toHaveBeenCalledWith('drop_disc', { room_id: 'room-1', col: 3 });
  });

  it('preserves per-client event order even though the rate check is async', async () => {
    const resolveOrder: string[] = [];
    const rateLimiter = {
      allow: jest.fn((key: string) => {
        // First check resolves slower than the second — without sequential
        // chaining this would let event 2 reach the backend before event 1.
        const delay = resolveOrder.length === 0 ? 10 : 0;
        resolveOrder.push(key);
        return new Promise((resolve) => setTimeout(() => resolve(true), delay));
      }),
    } as unknown as WsRateLimiterService;
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis(), rateLimiter);
    const client = makeClient();
    await (gw as any).bridge(client, '/domino', 'http://upstream');

    client.__fire('__onAny', 'drop_disc', { col: 1 });
    client.__fire('__onAny', 'drop_disc', { col: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(lastBackendSocket!.emit.mock.calls).toEqual([
      ['drop_disc', { col: 1 }],
      ['drop_disc', { col: 2 }],
    ]);
  });

  it('bypasses rate limiting when no limiter is wired (test/DI-less construction)', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient();
    await (gw as any).bridge(client, '/domino', 'http://upstream');

    client.__fire('__onAny', 'drop_disc', { room_id: 'room-1' });
    await flushMicrotasks();

    expect(lastBackendSocket!.emit).toHaveBeenCalledWith('drop_disc', { room_id: 'room-1' });
  });
});
