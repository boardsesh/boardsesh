import { describe, it, expect } from 'vitest';
import { normalizeScreenPath } from '../analytics-screen-path';

describe('normalizeScreenPath', () => {
  it('drops the (tabs) group marker and keeps a dynamic placeholder', () => {
    expect(normalizeScreenPath(['(tabs)', 'climbs', '[climbUuid]'])).toBe('/climbs/[climbUuid]');
  });

  it('returns "/" for empty segments', () => {
    expect(normalizeScreenPath([])).toBe('/');
  });

  it('returns "/" when only group markers remain', () => {
    expect(normalizeScreenPath(['(tabs)'])).toBe('/');
  });

  it('builds a simple tab path', () => {
    expect(normalizeScreenPath(['(tabs)', 'climbs'])).toBe('/climbs');
  });

  it('builds a top-level modal path (boards is no longer a tab)', () => {
    expect(normalizeScreenPath(['boards'])).toBe('/boards');
  });

  it('keeps nested dynamic segments', () => {
    expect(normalizeScreenPath(['(tabs)', 'discover', 'smart', '[type]'])).toBe('/discover/smart/[type]');
  });

  it('handles non-tab groups like auth', () => {
    expect(normalizeScreenPath(['auth', 'login'])).toBe('/auth/login');
  });
});
