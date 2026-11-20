// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({
  sessionId: 'session-123',
  redirect: vi.fn((_props: unknown) => null),
}));
vi.mock('expo-router', () => ({
  Redirect: route.redirect,
  useLocalSearchParams: () => ({ sessionId: route.sessionId }),
}));

import SessionLinkRoute from '../[sessionId]';

describe('shared session link', () => {
  it.each(['session-123', 'daily:climber-1:2026-11-20'])('opens recap %s with Home behind Back', (sessionId) => {
    route.sessionId = sessionId;
    route.redirect.mockClear();
    render(<SessionLinkRoute />);
    expect(route.redirect.mock.calls[0]?.[0]).toEqual({
      href: { pathname: '/(tabs)/home/session/[sessionId]', params: { sessionId } },
      withAnchor: true,
    });
  });
});
