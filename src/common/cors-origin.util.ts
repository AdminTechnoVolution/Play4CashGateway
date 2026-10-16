/**
 * The only environments where it's acceptable to fall back to reflecting any
 * origin (with credentials) when no explicit `CORS_ORIGINS` is configured.
 * Deliberately an allowlist, not a `!== 'production'` denylist — an unset
 * `NODE_ENV`, a typo, or a staging value like "sit" must resolve to the SAFE
 * (deny) behavior, not the permissive one.
 */
const PERMISSIVE_DEV_NODE_ENVS = new Set(['development', 'test']);

export function isPermissiveDevEnv(nodeEnv: string | undefined): boolean {
  return PERMISSIVE_DEV_NODE_ENVS.has((nodeEnv || '').trim().toLowerCase());
}

/**
 * Resolves the `cors` origin option for both the HTTP (`enableCors`) and
 * WebSocket (`@WebSocketGateway({ cors })`) layers from the same rule:
 * explicit origins always win; otherwise only known dev/test environments
 * get the permissive `true` (reflect any origin) — everything else denies
 * cross-origin access outright rather than silently trusting it.
 */
export function resolveCorsOrigin(
  nodeEnv: string | undefined,
  explicitOrigins: string[],
): string[] | boolean {
  if (explicitOrigins.length > 0) return explicitOrigins;
  return isPermissiveDevEnv(nodeEnv);
}
