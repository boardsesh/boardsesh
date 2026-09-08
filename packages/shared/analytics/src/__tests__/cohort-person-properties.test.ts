import { describe, it, expect } from 'vitest';
import { buildCohortPersonProperties, type CohortProfileInput } from '../cohort-person-properties';

const FULL_INPUT: CohortProfileInput = {
  isTester: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  email: 'climber@example.com',
  primaryBoard: 'kilter',
  favoriteCount: 12,
  integrationsConnectedCount: 1,
};

describe('buildCohortPersonProperties', () => {
  it('maps every resolved trait to its PostHog property name', () => {
    const { set, setOnce } = buildCohortPersonProperties(FULL_INPUT);

    expect(set).toEqual({
      role: 'user',
      email: 'climber@example.com',
      primary_board: 'kilter',
      favorite_count: 12,
      integrations_connected_count: 1,
    });
    expect(setOnce).toEqual({ first_seen_at: '2024-01-01T00:00:00.000Z' });
  });

  it('maps isTester true to the tester role', () => {
    const { set } = buildCohortPersonProperties({ ...FULL_INPUT, isTester: true });
    expect(set.role).toBe('tester');
  });

  it('sets unresolved traits to undefined so sanitizeForPosthog drops them', () => {
    const { set, setOnce } = buildCohortPersonProperties({
      isTester: null,
      createdAt: null,
      email: null,
      primaryBoard: null,
      favoriteCount: null,
      integrationsConnectedCount: null,
    });

    expect(set).toEqual({
      role: undefined,
      email: undefined,
      primary_board: undefined,
      favorite_count: undefined,
      integrations_connected_count: undefined,
    });
    expect(setOnce).toEqual({ first_seen_at: undefined });
  });
});
