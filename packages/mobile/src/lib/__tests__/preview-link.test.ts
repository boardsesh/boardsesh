import { describe, it, expect } from 'vitest';
import { parsePreviewChannel } from '../preview-link';
import { PRESET_CHANNELS } from '../channel-switch';

describe('parsePreviewChannel', () => {
  it('accepts the pr-<number> channels the preview workflow publishes', () => {
    expect(parsePreviewChannel('pr-1')).toBe('pr-1');
    expect(parsePreviewChannel('pr-3337')).toBe('pr-3337');
  });

  it('accepts every tester preset', () => {
    for (const channel of PRESET_CHANNELS) {
      expect(parsePreviewChannel(channel)).toBe(channel);
    }
  });

  it('takes the first value when Expo Router hands through a repeated param', () => {
    expect(parsePreviewChannel(['pr-12', 'pr-99'])).toBe('pr-12');
  });

  it('trims incidental whitespace', () => {
    expect(parsePreviewChannel(' pr-12 ')).toBe('pr-12');
  });

  it('rejects anything outside the whitelist', () => {
    // The channel comes from a URL, so a near-miss must not reach
    // performChannelSwitch — a bogus channel would strand the app mid-switch.
    expect(parsePreviewChannel('pr-')).toBeNull();
    expect(parsePreviewChannel('pr-12x')).toBeNull();
    expect(parsePreviewChannel('PR-12')).toBeNull();
    expect(parsePreviewChannel('pr-12/../production')).toBeNull();
    expect(parsePreviewChannel('staging')).toBeNull();
    expect(parsePreviewChannel('')).toBeNull();
    expect(parsePreviewChannel(undefined)).toBeNull();
    expect(parsePreviewChannel([])).toBeNull();
  });

  it('agrees with the web half on pr-0 and leading zeros', () => {
    // GitHub numbers PRs from 1. previewPullRequestNumber() on the web side
    // rejects these, so accepting them here would 404 the page while still
    // switching the app.
    expect(parsePreviewChannel('pr-0')).toBeNull();
    expect(parsePreviewChannel('pr-007')).toBeNull();
  });
});
