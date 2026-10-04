import { describe, expect, it, vi } from 'vitest';
import type { SessionFeedItem } from '@boardsesh/shared-schema';
import { navigateToSessionFeedItem } from '../session-feed-navigation';

describe('navigateToSessionFeedItem', () => {
  it('carries a daily card tick target into session detail', () => {
    const router = { push: vi.fn() } as unknown as Parameters<typeof navigateToSessionFeedItem>[0];
    const session = {
      sessionId: 'daily:user-a:2026-02-04',
      sessionType: 'daily_highlight',
      socialEntityType: 'tick',
      socialEntityId: 'tick-board-a',
    } as unknown as SessionFeedItem;

    navigateToSessionFeedItem(router, session, '/home/session/[sessionId]');

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/home/session/[sessionId]',
      params: { sessionId: 'daily:user-a:2026-02-04', highlightTickUuid: 'tick-board-a' },
    });
  });

  it('does not add a tick target to party-session navigation', () => {
    const router = { push: vi.fn() } as unknown as Parameters<typeof navigateToSessionFeedItem>[0];
    const session = {
      sessionId: 'party-1',
      sessionType: 'party',
      socialEntityType: 'session',
      socialEntityId: 'party-1',
    } as unknown as SessionFeedItem;

    navigateToSessionFeedItem(router, session, '/profile/session/[sessionId]');

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/profile/session/[sessionId]',
      params: { sessionId: 'party-1' },
    });
  });
});
