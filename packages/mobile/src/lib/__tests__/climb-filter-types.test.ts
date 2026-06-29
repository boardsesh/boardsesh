import { describe, it, expect } from 'vitest';
import { statusForAuth, DEFAULT_FILTERS, type ClimbFilters } from '../climb-filter-types';

// statusForAuth is the auth-gating invariant behind the native status Picker: a
// signed-out user can't pick "drafts", so a persisted drafts status is coerced to
// "any" at the source, otherwise the inline Picker renders a selection with no
// matching option (an orphaned/blank selection).
const withStatus = (status: ClimbFilters['status']): ClimbFilters => ({ ...DEFAULT_FILTERS, status });

describe('statusForAuth', () => {
  it('coerces a drafts status to any when signed out', () => {
    expect(statusForAuth(withStatus('drafts'), false).status).toBe('any');
  });

  it('keeps a drafts status when signed in (same reference, untouched)', () => {
    const filters = withStatus('drafts');
    expect(statusForAuth(filters, true)).toBe(filters);
  });

  it('leaves a non-drafts status unchanged when signed out (same reference)', () => {
    const filters = withStatus('any');
    expect(statusForAuth(filters, false)).toBe(filters);
  });
});
