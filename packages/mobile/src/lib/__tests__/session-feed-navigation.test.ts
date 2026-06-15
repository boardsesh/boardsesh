import { describe, it, expect, vi } from 'vitest';
import type { SessionFeedItem } from '@boardsesh/shared-schema';
import { navigateToSessionFeedItem } from '../session-feed-navigation';

// The per-tab pathname is the crux of the fix: a session opened from the Home
// feed must land in the Home stack and one from Profile -> Sessions in the Profile
// stack, so each keeps the native tab bar + bottom accessory and never switches
// tabs. Lock that the caller's route is forwarded verbatim to router.push.
type Router = Parameters<typeof navigateToSessionFeedItem>[0];

const session = { sessionId: 'sess-1' } as unknown as SessionFeedItem;

describe('navigateToSessionFeedItem', () => {
  it('pushes the session into the Home tab stack', () => {
    const push = vi.fn();
    navigateToSessionFeedItem({ push } as unknown as Router, session, '/(tabs)/home/session/[sessionId]');

    expect(push).toHaveBeenCalledWith({
      pathname: '/(tabs)/home/session/[sessionId]',
      params: { sessionId: 'sess-1' },
    });
  });

  it('pushes the session into the Profile tab stack', () => {
    const push = vi.fn();
    navigateToSessionFeedItem({ push } as unknown as Router, session, '/(tabs)/profile/session/[sessionId]');

    expect(push).toHaveBeenCalledWith({
      pathname: '/(tabs)/profile/session/[sessionId]',
      params: { sessionId: 'sess-1' },
    });
  });
});
