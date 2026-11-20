// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { name: string }) => options?.name ?? key }),
}));
vi.mock('../../lib/env', () => ({ WEB_BASE_URL: 'https://www.boardsesh.com' }));
vi.mock('../../lib/share-prewarm', () => ({
  buildProfileOgImageUrl: (userId: string) =>
    `https://ws.boardsesh.com/og/profile?user_id=${encodeURIComponent(userId)}`,
}));

import { useProfileShareOptions } from '../use-profile-share-options';

describe('profile sharing eligibility', () => {
  it('shares the canonical public profile and its token-free card', () => {
    const { result } = renderHook(() =>
      useProfileShareOptions({ userId: 'climber /1', displayName: 'Alex', isPrivate: false }),
    );
    expect(result.current.url).toBe('https://www.boardsesh.com/profile/climber%20%2F1');
    expect(result.current.prewarmOgImageUrl).toBe('https://ws.boardsesh.com/og/profile?user_id=climber%20%2F1');
    expect(result.current.message).toBe('Alex');
  });

  it.each([true, undefined])('hides links when privacy is %s', (isPrivate) => {
    const { result } = renderHook(() => useProfileShareOptions({ userId: 'u1', displayName: 'Alex', isPrivate }));
    expect(result.current.url).toBeNull();
    expect(result.current.prewarmOgImageUrl).toBeUndefined();
  });

  it('removes the link after the profile becomes private', () => {
    const { result, rerender } = renderHook(
      ({ isPrivate }) => useProfileShareOptions({ userId: 'u1', displayName: null, isPrivate }),
      { initialProps: { isPrivate: false } },
    );
    expect(result.current.message).toBe('page.displayNameFallback');
    expect(result.current.url).not.toBeNull();
    rerender({ isPrivate: true });
    expect(result.current.url).toBeNull();
  });

  it('hides the link before an identity loads', () => {
    const { result } = renderHook(() =>
      useProfileShareOptions({ userId: undefined, displayName: undefined, isPrivate: false }),
    );
    expect(result.current.url).toBeNull();
  });
});
