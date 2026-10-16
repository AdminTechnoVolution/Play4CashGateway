const port = process.argv[2];
if (!['3186', '3187'].includes(port)) throw new Error('Only dedicated localhost test ports are allowed');
Object.assign(process.env, { NODE_ENV: 'test', PORT: port, DOWNSTREAM_URL: `http://127.0.0.1:${Number(port) - 2}`,
  REDIS_URL: 'redis://127.0.0.1:6388', REDIS_URI: 'redis://127.0.0.1:6388',
  JWT_SECRET: 'p4c-e2e-test-only-secret-key-2026', JWT_ISSUER: 'play4cash-api', JWT_AUDIENCE: 'play4cash-clients',
  ENABLE_FAKE_LOGIN: 'false', ALLOW_HTTP_TOKEN_QUERY: 'false', CORS_ORIGINS: 'http://localhost:8100',
  PWA_MIN_VERSION: '', PWA_CURRENT_VERSION: '', REDIS_TOKEN_PREFIX: 'accessTokens:',
  ADMIN_JWT_SECRET_KEY: 'p4c-e2e-test-only-admin-secret-2026',
  GATEWAY_INTERNAL_SECRET: 'p4c-local-test-only-gateway-secret',
});
require('../dist/main.js');
