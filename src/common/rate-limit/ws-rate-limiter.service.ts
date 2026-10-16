import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

const INCR_SCRIPT = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return current
`;

/**
 * Fixed-window counter for inbound WebSocket events, keyed by whatever the
 * caller passes (typically `namespace:playerId` — player-scoped, not
 * IP-scoped, so a single account can't dodge the limit by reconnecting from
 * a different address).
 *
 * Fails OPEN on Redis errors: unlike the HTTP `gateway-rate-limit` (which
 * fails closed to protect the API), a WS rate limiter going down must not
 * itself become an outage for live games — that mirrors how token
 * revalidation already treats a Redis blip (`WsProxyGateway.validateActiveToken`).
 */
@Injectable()
export class WsRateLimiterService {
  private readonly logger = new Logger(WsRateLimiterService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async allow(key: string, limit: number, windowMs: number): Promise<boolean> {
    try {
      const current = (await (this.redis as any).eval(
        INCR_SCRIPT,
        1,
        `ws-rate-limit:${key}`,
        String(windowMs),
      )) as number;
      return current <= limit;
    } catch (err) {
      this.logger.warn(`event=ws_rate_limit_check_failed key=${key} err=${(err as Error).message}`);
      return true;
    }
  }
}
