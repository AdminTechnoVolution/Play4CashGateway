export const FAKE_LOGIN_PATH = '/api/login/fake';

/**
 * Mirrors the API's own `config.auth.fakeLoginEnabled` gate exactly (see
 * Play4CashApi's configuration.ts): requires an explicit opt-in AND a
 * non-production NODE_ENV, so the two services can never disagree about whether
 * the test-only login bypass is live. If only the API enabled it, the Gateway
 * would reject the request with 401 before it got there; if only the Gateway
 * did, the API would 404 it — either way it fails closed.
 */
export function isFakeLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_FAKE_LOGIN === 'true' && env.NODE_ENV !== 'production';
}
