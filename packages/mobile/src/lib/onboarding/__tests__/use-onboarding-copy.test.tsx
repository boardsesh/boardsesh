// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

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

const PROMPT_KEYS = ['title', 'body', 'footnote', 'findBoard', 'lookAround'] as const;

describe('useOnboardingCopy', () => {
  beforeEach(() => {
    translatorRef.t = (key: string) => key;
  });

  it('resolves every prompt copy field', () => {
    const { result } = renderHook(() => useOnboardingCopy());
    expect(result.current).toEqual({
      title: 'mobile.onboarding.prompt.title',
      body: 'mobile.onboarding.prompt.body',
      footnote: 'mobile.onboarding.prompt.footnote',
      findBoard: 'mobile.onboarding.prompt.findBoard',
      lookAround: 'mobile.onboarding.prompt.lookAround',
    });
  });

  it('uses static literal keys (orphan-checker contract)', () => {
    const seen: string[] = [];
    translatorRef.t = (key: string) => {
      seen.push(key);
      return key;
    };
    renderHook(() => useOnboardingCopy());
    for (const key of PROMPT_KEYS) {
      expect(seen).toContain(`mobile.onboarding.prompt.${key}`);
    }
    expect(seen).toHaveLength(PROMPT_KEYS.length);
  });

  it('returns a stable object while the translator identity is unchanged (memoised)', () => {
    const { result, rerender } = renderHook(() => useOnboardingCopy());
    const first = result.current;
    rerender();
    // Same `t` reference across renders → useMemo([t]) must reuse the object.
    expect(result.current).toBe(first);
  });

  it('recomputes when the translator identity changes (deps on [t])', () => {
    const { result, rerender } = renderHook(() => useOnboardingCopy());
    const first = result.current;
    // Swap the translator for a new function reference (how a real language
    // switch surfaces to the hook). The memo dep changes, so it must rebuild.
    translatorRef.t = (key: string) => key;
    rerender();
    expect(result.current).not.toBe(first);
  });
});
