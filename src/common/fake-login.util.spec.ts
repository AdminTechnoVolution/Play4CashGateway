import { isFakeLoginEnabled } from './fake-login.util';

describe('isFakeLoginEnabled', () => {
  it('is false when ENABLE_FAKE_LOGIN is unset', () => {
    expect(isFakeLoginEnabled({})).toBe(false);
  });

  it('is false when ENABLE_FAKE_LOGIN is true but NODE_ENV is production', () => {
    expect(isFakeLoginEnabled({ ENABLE_FAKE_LOGIN: 'true', NODE_ENV: 'production' })).toBe(false);
  });

  it('is true when ENABLE_FAKE_LOGIN is true and NODE_ENV is not production', () => {
    expect(isFakeLoginEnabled({ ENABLE_FAKE_LOGIN: 'true', NODE_ENV: 'test' })).toBe(true);
    expect(isFakeLoginEnabled({ ENABLE_FAKE_LOGIN: 'true' })).toBe(true);
    expect(isFakeLoginEnabled({ ENABLE_FAKE_LOGIN: 'true', NODE_ENV: 'staging' })).toBe(true);
  });

  it('is false for any non-"true" value, even truthy-looking ones', () => {
    expect(isFakeLoginEnabled({ ENABLE_FAKE_LOGIN: '1' })).toBe(false);
    expect(isFakeLoginEnabled({ ENABLE_FAKE_LOGIN: 'yes' })).toBe(false);
  });
});
