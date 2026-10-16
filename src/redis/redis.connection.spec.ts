import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { createGatewayRedis } from './redis.connection';
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));
const Constructor = Redis as unknown as jest.Mock;
function client(connect = jest.fn(async () => undefined)) {
  return { connect, disconnect: jest.fn(), on: jest.fn().mockReturnThis() };
}
describe('Gateway Redis startup', () => {
  beforeEach(() => { Constructor.mockReset(); });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
  it('waits for readiness without enabling an offline command queue', async () => {
    let ready!: () => void;
    const redis = client(jest.fn(() => new Promise<void>(resolve => { ready = resolve; })));
    Constructor.mockReturnValue(redis);
    let returned = false;
    const pending = createGatewayRedis(new ConfigService({ REDIS_URI: 'rediss://:fixture@redis.example:6380' })).then(value => { returned = true; return value; });
    await Promise.resolve(); expect(returned).toBe(false);
    ready(); expect(await pending).toBe(redis);
    expect(Constructor).toHaveBeenCalledWith('rediss://:fixture@redis.example:6380', expect.objectContaining({ lazyConnect: true, enableOfflineQueue: false }));
  });
  it('rejects conflicting URL variables and missing production configuration before connecting', async () => {
    await expect(createGatewayRedis(new ConfigService({ REDIS_URL: 'redis://old', REDIS_URI: 'redis://new' }))).rejects.toThrow('REDIS_URL y REDIS_URI');
    await expect(createGatewayRedis(new ConfigService({ NODE_ENV: 'production' }))).rejects.toThrow('Falta conexión Redis');
    expect(Constructor).not.toHaveBeenCalled();
  });
  it('fails closed and disconnects when Redis cannot connect, without exposing credentials', async () => {
    const redis = client(jest.fn(async () => { throw new Error('secret redis://password'); }));
    Constructor.mockReturnValue(redis);
    await expect(createGatewayRedis(new ConfigService({ REDIS_URI: 'redis://localhost' }))).rejects.toThrow('GATEWAY_REDIS_NOT_READY');
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
  it('bounds startup waiting when Redis never becomes ready', async () => {
    jest.useFakeTimers();
    const redis = client(jest.fn(() => new Promise<void>(() => {})));
    Constructor.mockReturnValue(redis);
    const rejection = expect(createGatewayRedis(new ConfigService({ REDIS_URI: 'redis://localhost' }))).rejects.toThrow('GATEWAY_REDIS_NOT_READY');
    await jest.advanceTimersByTimeAsync(15000); await rejection;
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
  it('logs safe connection error codes without emitting raw provider errors', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const redis = client(); Constructor.mockReturnValue(redis);
    await createGatewayRedis(new ConfigService({ REDIS_URI: 'redis://localhost' }));
    const handler = redis.on.mock.calls.find(([event]) => event === 'error')![1];
    handler(new Error('WRONGPASS contains-private-credential'));
    expect(log).toHaveBeenCalledWith('event=redis_connection_error code=AUTHENTICATION_FAILED');
  });
});
