/** Aligned Engine.IO ping settings (Gateway server + upstream client + API). */
export const SOCKET_IO_PING_OPTIONS = {
  pingInterval: 25_000,
  pingTimeout: 20_000,
  connectTimeout: 20_000,
} as const;
