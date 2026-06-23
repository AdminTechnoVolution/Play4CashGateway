import { resolveGatewayRateLimitConfig } from './gateway-rate-limit';

describe('resolveGatewayRateLimitConfig', () => {
  it('falls back to 50/min when env values are empty or invalid', () => {
    expect(resolveGatewayRateLimitConfig(undefined, undefined)).toEqual({
      windowMs: 60_000,
      max: 50,
    });

    expect(resolveGatewayRateLimitConfig('', '')).toEqual({
      windowMs: 60_000,
      max: 50,
    });

    expect(resolveGatewayRateLimitConfig('oops', 'nan')).toEqual({
      windowMs: 60_000,
      max: 50,
    });
  });

  it('accepts positive integer values', () => {
    expect(resolveGatewayRateLimitConfig('120000', '75')).toEqual({
      windowMs: 120_000,
      max: 75,
    });
  });
});
