export function normalizeGatewayPath(path: string | undefined | null): string {
  const raw = (path ?? '').split('?')[0].trim();
  if (!raw) return '';
  if (raw.length > 1 && raw.endsWith('/')) {
    return raw.replace(/\/+$/, '');
  }
  return raw;
}

export function parsePathSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((part) => normalizeGatewayPath(part))
      .filter(Boolean),
  );
}

export function shouldSkipGatewayRateLimit(
  method: string | undefined,
  path: string | undefined,
  publicPaths: Set<string>,
): boolean {
  if ((method ?? '').toUpperCase() === 'OPTIONS') return true;
  const normalizedPath = normalizeGatewayPath(path);
  if (!normalizedPath) return false;

  for (const publicPath of publicPaths) {
    if (normalizedPath === publicPath) return true;
    if (normalizedPath.startsWith(`${publicPath}/`)) return true;
  }

  return false;
}
