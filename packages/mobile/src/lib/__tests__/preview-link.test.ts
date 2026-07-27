import { describe, it, expect } from 'vitest';
import { parsePreviewChannel, parsePreviewLinkChannel } from '../preview-link';
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

// The link as it actually arrives from a PR comment. Hand-rolled parsing (no
// expo-linking, which can't import in a node test env), so every shape is pinned.
describe('parsePreviewLinkChannel', () => {
  it('reads the channel from the universal-link form', () => {
    expect(parsePreviewLinkChannel('https://www.boardsesh.com/preview/pr-1234')).toBe('pr-1234');
    expect(parsePreviewLinkChannel('https://boardsesh.com/preview/pr-1234')).toBe('pr-1234');
  });

  it('reads it from both custom-scheme spellings', () => {
    // Two slashes puts `preview` where a host would be; three is what
    // Linking.createURL() emits. Both must land on the same channel.
    expect(parsePreviewLinkChannel('com.boardsesh.app://preview/pr-1234')).toBe('pr-1234');
    expect(parsePreviewLinkChannel('com.boardsesh.app:///preview/pr-1234')).toBe('pr-1234');
  });

  it('tolerates a locale prefix, a trailing slash, and a query tail', () => {
    expect(parsePreviewLinkChannel('https://www.boardsesh.com/es/preview/pr-1234')).toBe('pr-1234');
    expect(parsePreviewLinkChannel('https://www.boardsesh.com/preview/pr-1234/')).toBe('pr-1234');
    expect(parsePreviewLinkChannel('https://www.boardsesh.com/preview/pr-1234?utm=x#frag')).toBe('pr-1234');
  });

  it('accepts a tester preset channel', () => {
    expect(parsePreviewLinkChannel('https://www.boardsesh.com/preview/preview-2')).toBe('preview-2');
  });

  it('returns null for anything that is not a preview link', () => {
    expect(parsePreviewLinkChannel('https://www.boardsesh.com/join/123')).toBeNull();
    expect(parsePreviewLinkChannel('https://www.boardsesh.com/previews/pr-1')).toBeNull();
    expect(parsePreviewLinkChannel('https://www.boardsesh.com/preview')).toBeNull();
    expect(parsePreviewLinkChannel('')).toBeNull();
  });

  it('still applies the channel whitelist to the URL segment', () => {
    // The segment rides a URL into performChannelSwitch — parsing it out must not
    // widen what parsePreviewChannel accepts.
    expect(parsePreviewLinkChannel('https://www.boardsesh.com/preview/pr-0')).toBeNull();
    expect(parsePreviewLinkChannel('https://www.boardsesh.com/preview/pr-12x')).toBeNull();
    expect(parsePreviewLinkChannel('https://www.boardsesh.com/preview/staging')).toBeNull();
    // `production` IS a preset, so /preview/production is a legitimate "put me
    // back on the shipped build" link, not a rejection case.
    expect(parsePreviewLinkChannel('https://www.boardsesh.com/preview/production')).toBe('production');
  });
});
