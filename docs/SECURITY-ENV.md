# Play4Cash — Security & Environment Matrix

This document describes the environment variables that must stay aligned across the three
applications so authentication, CORS, cookies, and gateway trust work end-to-end.

```
[ PWA ] ──HTTPS──▶ [ Gateway ] ──HTTPS+internal-secret──▶ [ API ]
   ▲                    │
   └── WS  ─────────────┘
```

## 1. Cross-cutting JWT contract

Issued by the API. Verified by the Gateway (HTTP middleware + WS proxy) and by the API itself.
All three apps MUST share the same values, otherwise tokens issued by the API are rejected by
the Gateway/API guards (and vice versa).

| Variable      | PWA | Gateway | API | Notes |
|---------------|-----|---------|-----|-------|
| `JWT_SECRET`  | —   | ✅       | ✅   | Symmetric secret. Rotate by re-issuing all sessions. |
| `JWT_ISSUER`  | —   | ✅       | ✅   | Default `play4cash-api`. |
| `JWT_AUDIENCE`| —   | ✅       | ✅   | Default `play4cash-clients`. |
| `JWT_ACCESS_TTL_SECS`  | — | — | ✅ | Short-lived (e.g. 900s). |
| `JWT_REFRESH_TTL_SECS` | — | — | ✅ | Days, e.g. `1209600` (14 days). |

The JWT payload includes:

- `typ` — `access` | `refresh` (refresh-typed tokens MUST NOT pass HTTP/WS auth).
- `jti` — Per-token UUID; the refresh `jti` is also tracked in Redis under
  `sessionFamilies:<familyId>` for reuse detection.
- `familyId` — Session family. All tokens issued from the same login share this id, so reuse or
  logout revokes the whole family in one shot.
- `role` — `admin` | `user` (signed from the User DB document at login/refresh, falling back to
  the `ADMIN_EMAILS` allowlist for legacy accounts).

## 2. CORS / Origins

The Gateway is the public edge. The API only sees Gateway traffic (and the strip middleware
removes spoofable headers).

| Variable          | PWA | Gateway | API | Notes |
|-------------------|-----|---------|-----|-------|
| `ALLOWED_ORIGINS` | —   | ✅       | ✅   | Comma-separated. MUST include the PWA origin. Gateway refuses to start with empty `CORS_ORIGINS` when `NODE_ENV=production`. |
| `VITE_API_URL`    | ✅   | —       | —   | Base URL the SPA hits. Leave empty in dev when using `VITE_DEV_PROXY_TARGET`. |

When using the httpOnly refresh cookie, the SPA's origin MUST match the API origin OR the
API/Gateway must respond with `Access-Control-Allow-Credentials: true` and an explicit
`Access-Control-Allow-Origin` matching the SPA origin. In production, the Gateway sits in
front of both and CORS is configured there.

## 3. Refresh cookie

| Variable                          | API | Notes |
|-----------------------------------|-----|-------|
| `AUTH_REFRESH_COOKIE_NAME`        | ✅   | e.g. `p4c_rt`. |
| `AUTH_REFRESH_COOKIE_SAMESITE`    | ✅   | `lax` (same-site), `strict`, or `none` (cross-site). |
| `AUTH_REFRESH_COOKIE_SECURE`      | ✅   | `true` in production. Auto-forced `true` when SameSite=none. |

The SPA never reads or writes this cookie. It only sends requests with
`withCredentials: true`. Logout and `POST /api/login/invalidate-browser-session` clear it.

## 4. Gateway → API internal trust

Used so the API knows that `x-gateway-user` (an internal hint we may add for logging) actually
came from the Gateway and not a client.

| Variable                     | Gateway | API | Notes |
|------------------------------|---------|-----|-------|
| `GATEWAY_INTERNAL_SECRET`    | ✅       | ✅   | Identical opaque value. Gateway appends, API verifies. |
| `GATEWAY_TRUST_HEADER_NAME`  | ✅       | ✅   | Default `x-gateway-internal`. |
| `TRUSTED_GATEWAY_IPS`        | —       | ✅   | Alternative to the secret; comma-separated IP allowlist. |

If neither secret nor trusted IPs are configured, the API strips `x-gateway-user` from every
request (safe default). The header is also stripped on every request after verification, so
downstream handlers can't re-inject it.

## 5. Rate limiting

| Variable          | API | Notes |
|-------------------|-----|-------|
| `THROTTLE_TTL_MS` | ✅   | Default 60 000. Global throttler window. |
| `THROTTLE_LIMIT`  | ✅   | Default 300/window. Specific endpoints (login, refresh, register, verify-code) override with stricter limits. |

`app.set('trust proxy', 1)` is enabled so client IPs are read from `X-Forwarded-For` behind
the Gateway.

## 6. Redis (token allowlist + session families)

The API writes to:

- `accessTokens:<jwt>` — set with TTL of access TTL. Cleared on logout/reuse-revoke.
- `refreshTokens:<jwt>` — set with TTL of refresh TTL. Rotated on every refresh.
- `sessionFamilies:<familyId>` — JSON `{ userId, currentJti }`. TTL = refresh TTL.
- `familyRefreshes:<familyId>` / `familyAccesses:<familyId>` — Sets used to cascade-revoke a
  whole family when logout or reuse is detected.

The Gateway reads only the prefix `accessTokens:` (via `REDIS_TOKEN_PREFIX`, default
`accessTokens:`) to validate access tokens during HTTP/WS auth.

| Variable             | Gateway | API | Notes |
|----------------------|---------|-----|-------|
| `REDIS_URL`          | ✅       | ✅   | Same Redis instance. |
| `REDIS_TOKEN_PREFIX` | ✅       | —   | Must equal the API constant `accessTokens:`. |

## 7. Tokens in URLs

Default is **off** for HTTP and **on for WebSockets** (the Gateway needs `?token=` in the WS
handshake URL because the browser cannot set `Authorization` on a WebSocket upgrade).

| Variable                 | Gateway | Notes |
|--------------------------|---------|-------|
| `ALLOW_HTTP_TOKEN_QUERY` | ✅       | Default `false`. Set to `true` only if you absolutely need it (logs can leak it). |

## 8. PWA-only

| Variable                  | Notes |
|---------------------------|-------|
| `VITE_API_URL`            | Production API origin. Leave empty in dev when using the proxy. |
| `VITE_GOOGLE_CLIENT_ID`   | OAuth client used at the login screen. |
| `VITE_DEV_PROXY_TARGET`   | Dev-only. When set, Vite proxies `/api` and `/socket.io` to that origin. |
| `VITE_DEV_PROXY_INSECURE` | Dev-only. `true` to allow self-signed HTTPS targets. |

## 9. PWA versioning contract

Both ends agree on a semver published by the SPA. The API can force a hard reload when it
ships a breaking change.

| Variable          | PWA | Gateway | API | Notes |
|-------------------|-----|---------|-----|-------|
| `PWA_MIN_VERSION` | —   | —       | ✅   | semver, e.g. `1.2.0`. Empty disables forced upgrades. The API ships it as `X-App-Min-Version` on every response. |

Two headers cross the wire on every API call:

- `X-App-Version` — sent by the PWA on every request. API stashes it on
  `req.clientAppVersion` for logs/metrics. Built from `__APP_VERSION__` (semver of
  `package.json` injected at build by `vite.config.ts`).
- `X-App-Min-Version` — sent by the API on every response when `PWA_MIN_VERSION` is set.
  PWA reads it via `versionContract.checkAppMinVersion` and dispatches the forced-update modal.

**CORS responsibility splits as follows** (the Gateway is the origin the browser sees):

| Concern | Where | Setting |
|---------|-------|---------|
| Allow `X-App-Version` on preflight | Gateway | `allowedHeaders: [..., 'X-App-Version']` |
| Expose `X-App-Min-Version` to JS | Gateway **and** API | `exposedHeaders: ['X-App-Min-Version']` |
| Pass headers through unchanged | Gateway | `http-proxy-middleware` defaults — do not add filters |

If you ever introduce a custom proxy that rewrites response headers, re-add the contract or
the forced-update flow silently breaks.

## 10. Deployment checklist

1. Generate a strong `JWT_SECRET` and an opaque `GATEWAY_INTERNAL_SECRET` (32+ random bytes).
2. Set identical `JWT_*`, `GATEWAY_INTERNAL_SECRET`, `GATEWAY_TRUST_HEADER_NAME` on Gateway
   and API.
3. Same `REDIS_URL` for Gateway and API. Same `REDIS_TOKEN_PREFIX` constant (`accessTokens:`).
4. `CORS_ORIGINS` on Gateway (and `ALLOWED_ORIGINS` on API) must include every PWA origin —
   no leading-wildcard subdomains in production.
5. PWA `VITE_API_URL` points to the Gateway, not the API directly.
6. In production: `AUTH_REFRESH_COOKIE_SECURE=true`, `AUTH_REFRESH_COOKIE_SAMESITE=lax` (or
   `none` if cross-site), `NODE_ENV=production`.
7. Bump `PWA_MIN_VERSION` only when the new build is **not** backward compatible with older
   PWA bundles. Otherwise leave it as-is and let the SW prompt flow handle the rollout.
