// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const redirect = vi.hoisted(() => vi.fn((_props: unknown) => null));
vi.mock('expo-router', () => ({
  Redirect: redirect,
  useLocalSearchParams: () => ({ username: 'jimmy webb' }),
}));

import SetterLinkRoute from '../[username]';

describe('shared setter link', () => {
  it('opens the setter in Discover, with Discover behind it for Back', () => {
    render(<SetterLinkRoute />);
    expect(redirect.mock.calls[0]?.[0]).toEqual({
      href: { pathname: '/(tabs)/discover/setter/[username]', params: { username: 'jimmy webb' } },
      withAnchor: true,
    });
  });
});
