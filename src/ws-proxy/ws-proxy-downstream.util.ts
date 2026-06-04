/** Namespaces where a transport flap should not tear down the upstream game socket. */
export const LOBBY_OR_META_NAMESPACES = new Set(['/chat', '/rooms', '/tournaments']);

export function isGameNamespace(namespace: string): boolean {
  return namespace.startsWith('/') && !LOBBY_OR_META_NAMESPACES.has(namespace);
}

/** Socket.IO game gateways emit the namespace name without the leading slash. */
export function gameEventNameForNamespace(namespace: string): string {
  return namespace.replace(/^\//, '');
}

export function extractPlayerId(payload: Record<string, unknown>): string {
  const id = payload.id ?? payload.sub;
  return id != null ? String(id) : '';
}

export function isIntentionalClientDisconnect(reason: string): boolean {
  return reason === 'io client disconnect';
}

export function extractRoomIdFromJoinArgs(args: unknown[]): string | undefined {
  const body = args[0];
  if (!body || typeof body !== 'object') return undefined;
  const roomId = (body as Record<string, unknown>).room_id;
  return roomId != null ? String(roomId) : undefined;
}

export function extractRoomIdFromRoomDeletedArgs(args: unknown[]): string | undefined {
  const body = args[0];
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (typeof body === 'object') {
    const id = (body as Record<string, unknown>).id ?? (body as Record<string, unknown>).room_id;
    return id != null ? String(id) : undefined;
  }
  return undefined;
}

export function isTerminalGameEnvelope(args: unknown[]): boolean {
  const envelope = args[0];
  if (!envelope || typeof envelope !== 'object') return false;
  const data = (envelope as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return false;
  return (data as Record<string, unknown>).gameEnded === true;
}

/** Bug B: canonical terminal payload the PWA can listen for before lobby `roomDeleted`. */
export function buildResultEnvelope(args: unknown[]): Record<string, unknown> {
  const base =
    args[0] && typeof args[0] === 'object' ? { ...(args[0] as Record<string, unknown>) } : {};
  return { ...base, roomCloseReason: 'gameFinished' };
}
