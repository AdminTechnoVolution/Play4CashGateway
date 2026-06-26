import { normalizeGatewayPath, parsePathSet, shouldSkipGatewayRateLimit } from './http-path.util';

describe('http-path.util', () => {
  it('normalizes trailing slashes and query strings', () => {
    expect(normalizeGatewayPath('/api/login/')).toBe('/api/login');
    expect(normalizeGatewayPath('/api/login/?foo=1')).toBe('/api/login');
  });

  it('parses comma-separated path lists', () => {
    expect(parsePathSet('/api/login, /api/rooms/stats/')).toEqual(
      new Set(['/api/login', '/api/rooms/stats']),
    );
  });

  it('skips OPTIONS and public paths for rate limiting', () => {
    const publicPaths = parsePathSet('/api/login,/api/rooms/stats');
    expect(shouldSkipGatewayRateLimit('OPTIONS', '/api/user/account', publicPaths)).toBe(true);
    expect(shouldSkipGatewayRateLimit('GET', '/api/login', publicPaths)).toBe(true);
    expect(shouldSkipGatewayRateLimit('GET', '/api/user/account', publicPaths)).toBe(false);
  });

  it('treats configured paths as prefixes for nested routes', () => {
    const publicPaths = parsePathSet('/api/login,/api/rooms/game,/api/user/account');
    expect(shouldSkipGatewayRateLimit('GET', '/api/login/refresh', publicPaths)).toBe(true);
    expect(shouldSkipGatewayRateLimit('GET', '/api/rooms/game/123', publicPaths)).toBe(true);
    expect(shouldSkipGatewayRateLimit('GET', '/api/user/account/details', publicPaths)).toBe(true);
    expect(shouldSkipGatewayRateLimit('GET', '/api/rooms/stats', publicPaths)).toBe(false);
  });
});
