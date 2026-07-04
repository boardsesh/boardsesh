import { describe, expect, it } from 'vitest';
import { buildCohortPersonProperties } from '../analytics-person-properties';

describe('buildCohortPersonProperties', () => {
  it('maps a regular user with an active board', () => {
    const { set, setOnce } = buildCohortPersonProperties({
      accountCreatedAt: '2024-01-02T03:04:05.000Z',
      homeBoard: 'kilter',
      isTester: false,
      favoriteCount: 12,
    });

    expect(set).toEqual({ role: 'user', favorite_count: 12, home_board: 'kilter' });
    expect(setOnce).toEqual({ account_created_at: '2024-01-02T03:04:05.000Z' });
  });

  it('marks tester accounts with the tester role', () => {
    const { set } = buildCohortPersonProperties({
      accountCreatedAt: '2024-01-02T03:04:05.000Z',
      homeBoard: 'tension',
      isTester: true,
      favoriteCount: 0,
    });

    expect(set.role).toBe('tester');
    expect(set.home_board).toBe('tension');
  });

  it('omits home_board when no board is picked yet', () => {
    const { set } = buildCohortPersonProperties({
      accountCreatedAt: '2024-01-02T03:04:05.000Z',
      homeBoard: null,
      isTester: false,
      favoriteCount: 3,
    });

    expect(set).toEqual({ role: 'user', favorite_count: 3 });
    expect('home_board' in set).toBe(false);
  });

  it('keeps account_created_at only in setOnce (immutable trait)', () => {
    const { set, setOnce } = buildCohortPersonProperties({
      accountCreatedAt: '2020-06-01T00:00:00.000Z',
      homeBoard: 'kilter',
      isTester: false,
      favoriteCount: 5,
    });

    expect('account_created_at' in set).toBe(false);
    expect(setOnce).toEqual({ account_created_at: '2020-06-01T00:00:00.000Z' });
  });
});
