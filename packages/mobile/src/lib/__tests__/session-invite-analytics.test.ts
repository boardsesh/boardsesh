import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../analytics', () => ({ track: analytics.track }));
vi.mock('react-native', () => ({
  Share: { sharedAction: 'sharedAction', dismissedAction: 'dismissedAction' },
}));

import {
  trackSessionInviteLinkCopied,
  trackSessionInviteSheetOpened,
  trackSessionInviteSystemShare,
} from '../session-invite-analytics';

beforeEach(() => {
  analytics.track.mockClear();
});

describe('session invite analytics', () => {
  it('counts the sheet being opened, per session', () => {
    trackSessionInviteSheetOpened('session-1');

    expect(analytics.track).toHaveBeenCalledWith('Session Invite Sheet Opened', { sessionId: 'session-1' });
  });

  it('counts a copied link as a share with its method', () => {
    trackSessionInviteLinkCopied('session-1');

    expect(analytics.track).toHaveBeenCalledWith('Session Invite Shared', {
      sessionId: 'session-1',
      method: 'copy_link',
    });
  });

  it('names the app the link went to when iOS reports it', () => {
    trackSessionInviteSystemShare('session-1', {
      action: 'sharedAction',
      activityType: 'net.whatsapp.WhatsApp.ShareExtension',
    });

    expect(analytics.track).toHaveBeenCalledWith('Session Invite Shared', {
      sessionId: 'session-1',
      method: 'system_share',
      shareTarget: 'net.whatsapp.WhatsApp.ShareExtension',
    });
  });

  it('sends no share target when the platform reports none (Android)', () => {
    trackSessionInviteSystemShare('session-1', { action: 'sharedAction' });

    expect(analytics.track).toHaveBeenCalledWith('Session Invite Shared', {
      sessionId: 'session-1',
      method: 'system_share',
    });
  });

  it('counts nothing when the share sheet was dismissed', () => {
    trackSessionInviteSystemShare('session-1', { action: 'dismissedAction' });

    expect(analytics.track).not.toHaveBeenCalled();
  });
});
