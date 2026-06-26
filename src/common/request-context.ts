import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  requestId: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(requestId: string, callback: () => T): T {
  return requestContextStorage.run({ requestId }, callback);
}

export function getCurrentRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}

export function createRequestId(rawId?: unknown): string {
  const candidate = typeof rawId === 'string' ? rawId.trim() : '';
  return candidate || randomUUID();
}
