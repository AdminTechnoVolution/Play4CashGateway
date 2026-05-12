import { compareSemver } from './semver-compare.util';

describe('compareSemver (Gateway)', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns negative when a < b', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareSemver('1.2.3', '2.0.0')).toBeLessThan(0);
  });

  it('returns positive when a > b', () => {
    expect(compareSemver('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareSemver('1', '1.0.0')).toBe(0);
    expect(compareSemver('1.2', '1.2.1')).toBeLessThan(0);
  });

  it('ignores +build suffixes', () => {
    expect(compareSemver('1.2.3+abc1234', '1.2.3+def5678')).toBe(0);
  });

  it('treats non-numeric segments as zero (defensive)', () => {
    expect(compareSemver('1.x.3', '1.0.3')).toBe(0);
  });
});
