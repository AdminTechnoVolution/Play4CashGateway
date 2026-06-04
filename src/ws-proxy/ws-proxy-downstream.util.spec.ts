import {
  buildResultEnvelope,
  extractRoomIdFromRoomDeletedArgs,
  gameEventNameForNamespace,
  isGameNamespace,
  isIntentionalClientDisconnect,
  isTerminalGameEnvelope,
} from './ws-proxy-downstream.util';

describe('ws-proxy-downstream.util', () => {
  it('classifies game namespaces', () => {
    expect(isGameNamespace('/chess')).toBe(true);
    expect(isGameNamespace('/rooms')).toBe(false);
  });

  it('maps namespace to game event name', () => {
    expect(gameEventNameForNamespace('/connect-four')).toBe('connect-four');
  });

  it('detects intentional client disconnect', () => {
    expect(isIntentionalClientDisconnect('io client disconnect')).toBe(true);
    expect(isIntentionalClientDisconnect('transport close')).toBe(false);
  });

  it('detects terminal game envelopes', () => {
    expect(
      isTerminalGameEnvelope([
        { success: true, data: { gameEnded: true, outcome: 'win' } },
      ]),
    ).toBe(true);
    expect(isTerminalGameEnvelope([{ success: true, data: { gameEnded: false } }])).toBe(
      false,
    );
  });

  it('builds result envelope with roomCloseReason gameFinished', () => {
    const envelope = buildResultEnvelope([
      { success: true, data: { gameEnded: true, outcome: 'win' }, messages: [] },
    ]);
    expect(envelope.roomCloseReason).toBe('gameFinished');
    expect((envelope.data as { outcome: string }).outcome).toBe('win');
  });

  it('extracts room id from roomDeleted payloads', () => {
    expect(extractRoomIdFromRoomDeletedArgs([{ id: 'abc' }])).toBe('abc');
    expect(extractRoomIdFromRoomDeletedArgs(['abc'])).toBe('abc');
  });
});
