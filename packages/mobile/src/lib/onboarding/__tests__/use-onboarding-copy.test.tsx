// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ONBOARDING_CARDS } from '../onboarding-cards';

// Controllable translator: each render reads the current `t` from this ref, so a
// test can hold the identity stable (memo should reuse) or swap it (memo should
// recompute), exercising the useMemo `[t]` dependency.
const translatorRef = vi.hoisted(() => ({
  t: ((key: string) => key) as (key: string) => string,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translatorRef.t }),
}));

import { useOnboardingCopy } from '../use-onboarding-copy';

describe('useOnboardingCopy', () => {
  beforeEach(() => {
    translatorRef.t = (key: string) => key;
  });

  it('resolves title + body for every card id', () => {
    const { result } = renderHook(() => useOnboardingCopy());
    for (const card of ONBOARDING_CARDS) {
      expect(result.current[card.id]).toEqual({
        title: `mobile.onboarding.cards.${card.id}.title`,
        body: `mobile.onboarding.cards.${card.id}.body`,
      });
    }
  });

  it('uses static literal keys per card (orphan-checker contract)', () => {
    const seen: string[] = [];
    translatorRef.t = (key: string) => {
      seen.push(key);
      return key;
    };
    renderHook(() => useOnboardingCopy());
    // Eight keys total: title + body for each of the four cards.
    for (const card of ONBOARDING_CARDS) {
      expect(seen).toContain(`mobile.onboarding.cards.${card.id}.title`);
      expect(seen).toContain(`mobile.onboarding.cards.${card.id}.body`);
    }
    expect(seen).toHaveLength(ONBOARDING_CARDS.length * 2);
  });

  it('returns a stable map while the translator identity is unchanged (memoised)', () => {
    const { result, rerender } = renderHook(() => useOnboardingCopy());
    const first = result.current;
    rerender();
    // Same `t` reference across renders → useMemo([t]) must reuse the map.
    expect(result.current).toBe(first);
  });

  it('recomputes when the translator identity changes (deps on [t])', () => {
    const { result, rerender } = renderHook(() => useOnboardingCopy());
    const first = result.current;
    // Swap the translator for a new function reference (a fresh `t` is how a
    // real language switch surfaces to the hook). The memo dep changes, so the
    // map must be rebuilt rather than served stale.
    translatorRef.t = (key: string) => key;
    rerender();
    expect(result.current).not.toBe(first);
  });
});
