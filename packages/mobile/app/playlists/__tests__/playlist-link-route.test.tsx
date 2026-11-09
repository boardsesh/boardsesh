// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const redirect = vi.hoisted(() => vi.fn((_props: unknown) => null));
vi.mock('expo-router', () => ({
  Redirect: redirect,
  useLocalSearchParams: () => ({ playlist_uuid: 'abc-123' }),
}));

import PlaylistLinkRoute from '../[playlist_uuid]';

describe('shared playlist link', () => {
  it('opens the playlist in Discover, with Discover behind it for Back', () => {
    render(<PlaylistLinkRoute />);
    expect(redirect.mock.calls[0]?.[0]).toEqual({
      href: { pathname: '/(tabs)/discover/[playlist_uuid]', params: { playlist_uuid: 'abc-123' } },
      withAnchor: true,
    });
  });
});
