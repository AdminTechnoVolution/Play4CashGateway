import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsProxyGateway } from './ws-proxy.gateway';
import type { RedisService } from '../redis/redis.service';
import type { Socket } from 'socket.io';

function makeClient(): Socket {
  return { emit: jest.fn() } as unknown as Socket;
}

function makeConfigService(): ConfigService {
  return { get: <T>(_k: string, def?: T) => def } as ConfigService;
}

describe('WsProxyGateway game-end ordering (Bug B)', () => {
  it('emits result before chess payload and defers roomDeleted until result', () => {
    const gw = new WsProxyGateway(
      makeConfigService(),
      {} as JwtService,
      {} as RedisService,
    );
    const chessClient = makeClient();
    const roomsClient = makeClient();
    const playerId = 'player-1';

    (gw as any).registerClientNamespace(playerId, '/chess', chessClient);
    (gw as any).registerClientNamespace(playerId, '/rooms', roomsClient);
    (gw as any).getUserTrack(playerId).lastRoomIdByNamespace.set('/chess', 'room-42');

    (gw as any).forwardDownstream(
      roomsClient,
      '/rooms',
      playerId,
      'roomDeleted',
      [{ id: 'room-42' }],
    );
    expect(roomsClient.emit).not.toHaveBeenCalled();

    (gw as any).forwardDownstream(chessClient, '/chess', playerId, 'chess', [
      { success: true, data: { gameEnded: true, outcome: 'win' }, messages: [] },
    ]);

    const calls = (chessClient.emit as jest.Mock).mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe('result');
    expect(calls[1]).toBe('chess');
    expect((chessClient.emit as jest.Mock).mock.calls[0][1].roomCloseReason).toBe(
      'gameFinished',
    );
    expect(roomsClient.emit).toHaveBeenCalledWith('roomDeleted', { id: 'room-42' });
  });

  it('passes roomDeleted immediately when result was already emitted', () => {
    const gw = new WsProxyGateway(
      makeConfigService(),
      {} as JwtService,
      {} as RedisService,
    );
    const roomsClient = makeClient();
    const playerId = 'player-2';
    (gw as any).registerClientNamespace(playerId, '/rooms', roomsClient);
    (gw as any).getUserTrack(playerId).resultEmittedRoomIds.add('room-9');

    (gw as any).forwardDownstream(
      roomsClient,
      '/rooms',
      playerId,
      'roomDeleted',
      [{ id: 'room-9' }],
    );

    expect(roomsClient.emit).toHaveBeenCalledWith('roomDeleted', { id: 'room-9' });
  });
});
