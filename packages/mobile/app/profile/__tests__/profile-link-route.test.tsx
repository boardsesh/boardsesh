// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const redirect = vi.hoisted(() => vi.fn((_props: unknown) => null));
vi.mock('expo-router', () => ({
  Redirect: redirect,
  useLocalSearchParams: () => ({ user_id: 'climber-123' }),
}));

import ProfileLinkRoute from '../[user_id]';

describe('shared profile link', () => {
  it('opens the user detail with Profile behind it for Back', () => {
    render(<ProfileLinkRoute />);
    expect(redirect.mock.calls[0]?.[0]).toEqual({
      href: { pathname: '/(tabs)/profile/users/[userId]', params: { userId: 'climber-123' } },
      withAnchor: true,
    });
  });
});
