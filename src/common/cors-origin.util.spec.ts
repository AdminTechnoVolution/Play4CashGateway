import { isPermissiveDevEnv, resolveCorsOrigin } from './cors-origin.util';

describe('resolveCorsOrigin', () => {
  it('always uses the explicit origin list when one is configured, regardless of NODE_ENV', () => {
    expect(resolveCorsOrigin('production', ['https://play4cash.net'])).toEqual([
      'https://play4cash.net',
    ]);
    expect(resolveCorsOrigin(undefined, ['https://play4cash.net'])).toEqual([
      'https://play4cash.net',
    ]);
  });

  it('reflects any origin only in explicit dev/test environments when none is configured', () => {
    expect(resolveCorsOrigin('development', [])).toBe(true);
    expect(resolveCorsOrigin('test', [])).toBe(true);
  });

  it('denies cross-origin access when NODE_ENV is unset, mistyped, or a staging label', () => {
    expect(resolveCorsOrigin(undefined, [])).toBe(false);
    expect(resolveCorsOrigin('', [])).toBe(false);
    expect(resolveCorsOrigin('Production', [])).toBe(false); // case mismatch is not "production"
    expect(resolveCorsOrigin('sit', [])).toBe(false);
    expect(resolveCorsOrigin('staging', [])).toBe(false);
    expect(resolveCorsOrigin('production', [])).toBe(false);
  });
});

describe('isPermissiveDevEnv', () => {
  it('is true only for development and test, case-insensitively', () => {
    expect(isPermissiveDevEnv('development')).toBe(true);
    expect(isPermissiveDevEnv('DEVELOPMENT')).toBe(true);
    expect(isPermissiveDevEnv('test')).toBe(true);
    expect(isPermissiveDevEnv('production')).toBe(false);
    expect(isPermissiveDevEnv('sit')).toBe(false);
    expect(isPermissiveDevEnv(undefined)).toBe(false);
  });
});
