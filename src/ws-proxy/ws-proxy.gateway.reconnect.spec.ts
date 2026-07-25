import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsProxyGateway } from './ws-proxy.gateway';
import type { RedisService } from '../redis/redis.service';

/**
 * Phase D — backend reconnection contract.
 *
 * The gateway must:
 *  1. Construct its upstream Socket.IO client with `reconnection: true` and bounded
 *     attempts so a flapping API doesn't hang sessions indefinitely.
 *  2. Cache the last `join`/`subscribe` event the PWA sent so we can replay it after
 *     a successful upstream reconnect (the new socket id needs to re-enter the room).
 *  3. Tear down everything cleanly when the downstream PWA client disconnects, even
 *     if a reconnect is mid-flight.
 *
 * These guarantees are what stops "I got dropped for 2 seconds and lost my whole
 * match" complaints, so we lock them in here.
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
  __fire(event: string, ...args: unknown[]): void;
  __fireManager(event: string, ...args: unknown[]): void;
}

const lastIoClientCall: { args: any[] } = { args: [] };
let lastBackendSocket: FakeBackendSocket | undefined;

jest.mock('socket.io-client', () => {
  return {
    io: jest.fn((url: string, opts: Record<string, unknown>) => {
      const handlers = new Map<string, Handler>();
      const managerHandlers = new Map<string, Handler>();
      const socket: FakeBackendSocket = {
        on: jest.fn((event: string, cb: Handler) => {
          handlers.set(event, cb);
        }),
        onAny: jest.fn(),
        emit: jest.fn(),
        disconnect: jest.fn(),
        io: {
          on: jest.fn((event: string, cb: Handler) => {
            managerHandlers.set(event, cb);
          }),
          off: jest.fn((event: string) => {
            managerHandlers.delete(event);
          }),
        },
        connected: false,
        __fire(event, ...args) {
          handlers.get(event)?.(...args);
        },
        __fireManager(event, ...args) {
          managerHandlers.get(event)?.(...args);
        },
      };
      lastIoClientCall.args = [url, opts];
      lastBackendSocket = socket;
      return socket;
    }),
    Socket: class {},
  };
});

function makeClient(): FakeClient {
  const clientHandlers = new Map<string, Handler>();
  let onAnyCb: Handler | null = null;
  const client: FakeClient = {
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
  return client;
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

function makeRedis(valid = true): RedisService {
  return { isTokenValid: jest.fn().mockResolvedValue(valid) } as unknown as RedisService;
}

describe('WsProxyGateway upstream reconnection (Phase D)', () => {
  beforeEach(() => {
    lastBackendSocket = undefined;
    lastIoClientCall.args = [];
  });

  it('creates the upstream socket with infinite reconnection options', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient();

    await (gw as any).bridge(client, '/uno', 'http://upstream');

    expect(lastIoClientCall.args[1]).toMatchObject({
      reconnection: true,
      reconnectionAttempts: Infinity,
    });
    expect(lastBackendSocket?.io.on).toHaveBeenCalledWith('reconnect_attempt', expect.any(Function));
    expect(lastBackendSocket?.io.on).toHaveBeenCalledWith('reconnect', expect.any(Function));
    expect(lastBackendSocket?.io.on).not.toHaveBeenCalledWith('reconnect_failed', expect.any(Function));
  });

  it('replays the last join event when the upstream reconnects', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient();
    await (gw as any).bridge(client, '/uno', 'http://upstream');

    // Simulate the PWA emitting join with a room_id while upstream is up.
    lastBackendSocket!.connected = true;
    client.__fire('__onAny', 'join', { room_id: 'room-9' });

    // Now the upstream drops & recovers.
    lastBackendSocket!.connected = false;
    lastBackendSocket!.emit.mockClear();
    lastBackendSocket!.__fireManager('reconnect', 1);

    expect(lastBackendSocket!.emit).toHaveBeenCalledWith('join', { room_id: 'room-9' });
    expect(client.emit).toHaveBeenCalledWith('proxy_reconnected', { namespace: '/uno' });
  });

  it('replays the most recent join only (not stale ones)', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient();
    await (gw as any).bridge(client, '/uno', 'http://upstream');

    lastBackendSocket!.connected = true;
    client.__fire('__onAny', 'join', { room_id: 'first' });
    client.__fire('__onAny', 'join', { room_id: 'second' });

    lastBackendSocket!.emit.mockClear();
    lastBackendSocket!.__fireManager('reconnect', 1);

    expect(lastBackendSocket!.emit).toHaveBeenCalledTimes(1);
    expect(lastBackendSocket!.emit).toHaveBeenCalledWith('join', { room_id: 'second' });
  });

  it('replays get_state after reconnect so a missed gameStarted event is recoverable', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient();
    await (gw as any).bridge(client, '/domino', 'http://upstream');

    lastBackendSocket!.connected = true;
    client.__fire('__onAny', 'get_state', { room_id: 'room-started' });

    lastBackendSocket!.emit.mockClear();
    lastBackendSocket!.__fireManager('reconnect', 1);

    expect(lastBackendSocket!.emit).toHaveBeenCalledTimes(1);
    expect(lastBackendSocket!.emit).toHaveBeenCalledWith('get_state', { room_id: 'room-started' });
  });

  it('does not duplicate a queued get_state while reconnecting', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient();
    await (gw as any).bridge(client, '/domino', 'http://upstream');

    lastBackendSocket!.connected = false;
    client.__fire('__onAny', 'get_state', { room_id: 'room-started' });

    lastBackendSocket!.emit.mockClear();
    lastBackendSocket!.__fireManager('reconnect', 1);

    expect(lastBackendSocket!.emit).toHaveBeenCalledTimes(1);
    expect(lastBackendSocket!.emit).toHaveBeenCalledWith('get_state', { room_id: 'room-started' });
  });

  it('caches subscribe events too (lobby /rooms namespace)', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient();
    await (gw as any).bridge(client, '/rooms', 'http://upstream');

    lastBackendSocket!.connected = true;
    client.__fire('__onAny', 'subscribe', { game_id: 'g-1', room_id: 'room-1' });

    lastBackendSocket!.emit.mockClear();
    lastBackendSocket!.__fireManager('reconnect', 2);

    expect(lastBackendSocket!.emit).toHaveBeenCalledWith('subscribe', {
      game_id: 'g-1',
      room_id: 'room-1',
    });
  });

  it('forwards authoritative roomState without transforming it', () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient();
    const state = {
      roomId: 'room-1',
      gameId: 'g-1',
      status: 'started',
      isCurrentUserInRoom: true,
      canEnterPlay: true,
    };

    (gw as any).forwardDownstream(
      client,
      '/rooms',
      'player-test',
      'roomState',
      [state],
    );

    expect(client.emit).toHaveBeenCalledWith('roomState', state);
  });

  it('replays tournament:join after upstream reconnect', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient();
    await (gw as any).bridge(client, '/tournaments', 'http://upstream');

    lastBackendSocket!.connected = true;
    client.__fire('__onAny', 'tournament:join', { tournament_id: 't-1' });

    lastBackendSocket!.emit.mockClear();
    lastBackendSocket!.__fireManager('reconnect', 1);

    expect(lastBackendSocket!.emit).toHaveBeenCalledWith('tournament:join', { tournament_id: 't-1' });
  });

  it('does not disconnect PWA when upstream keeps retrying (no reconnect_failed hook)', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient();
    await (gw as any).bridge(client, '/uno', 'http://upstream');

    expect(lastBackendSocket!.io.on).not.toHaveBeenCalledWith('reconnect_failed', expect.any(Function));
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('parks upstream socket on transport disconnect (Bug A) instead of immediate teardown', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient();
    await (gw as any).bridge(client, '/uno', 'http://upstream');

    client.__fire('disconnect', 'transport close');

    expect(lastBackendSocket!.io.off).not.toHaveBeenCalled();
    expect(lastBackendSocket!.disconnect).not.toHaveBeenCalled();
    expect((gw as any).parkedSessions.size).toBe(1);
  });

  it('tears down upstream on intentional PWA disconnect', async () => {
    const gw = new WsProxyGateway(makeConfigService(), makeJwt(), makeRedis());
    const client = makeClient();
    await (gw as any).bridge(client, '/uno', 'http://upstream');

    client.__fire('disconnect', 'io client disconnect');

    expect(lastBackendSocket!.io.off).toHaveBeenCalledWith('reconnect_attempt', expect.any(Function));
    expect(lastBackendSocket!.io.off).toHaveBeenCalledWith('reconnect', expect.any(Function));
    expect(lastBackendSocket!.disconnect).toHaveBeenCalled();
  });
});
