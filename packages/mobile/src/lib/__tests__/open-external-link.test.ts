import { describe, it, expect, vi, beforeEach } from 'vitest';

const linking = vi.hoisted(() => ({ openURL: vi.fn(), canOpenURL: vi.fn() }));

vi.mock('react-native', () => ({ Linking: linking }));

import { openValidatedUrl } from '../open-external-link';

const allow = () => true;
const deny = () => false;

beforeEach(() => {
  linking.openURL.mockReset();
  linking.canOpenURL.mockReset();
});

describe('openValidatedUrl', () => {
  it('opens a valid URL and reports success', async () => {
    linking.openURL.mockResolvedValue(undefined);

    const opened = await openValidatedUrl('https://www.instagram.com/reel/abc/', allow);

    expect(opened).toBe(true);
    expect(linking.openURL).toHaveBeenCalledWith('https://www.instagram.com/reel/abc/');
  });

  it('rejects an invalid URL without calling openURL', async () => {
    const opened = await openValidatedUrl('javascript:alert(1)', deny);

    expect(opened).toBe(false);
    expect(linking.openURL).not.toHaveBeenCalled();
  });

  it('returns false when openURL rejects (no handler available)', async () => {
    linking.openURL.mockRejectedValue(new Error('no activity found'));

    const opened = await openValidatedUrl('https://www.tiktok.com/@u/video/1', allow);

    expect(opened).toBe(false);
  });

  // Regression guard for the Android beta-video bug: never gate on canOpenURL,
  // which returns false on Android 11+ for undeclared schemes even though
  // openURL succeeds.
  it('never calls canOpenURL', async () => {
    linking.openURL.mockResolvedValue(undefined);

    await openValidatedUrl('https://www.instagram.com/reel/abc/', allow);

    expect(linking.canOpenURL).not.toHaveBeenCalled();
  });
});
