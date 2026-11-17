import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { iosStoryNavigationFlow } from '../lib/ios-story-navigation';

describe('iOS story navigation confirmation', () => {
  it('handles a missing prompt but bounds retries and verifies a present prompt disappeared in portrait', () => {
    const documents = parseAllDocuments(
      iosStoryNavigationFlow(
        'com.boardsesh.app',
        'com.boardsesh.app://dev/stories/climbs--populated?shot=123',
        'LANDSCAPE_LEFT',
      ),
    );
    expect(documents.every((document) => document.errors.length === 0)).toBe(true);
    expect(documents[1].toJSON()).toEqual([
      { setOrientation: 'PORTRAIT' },
      { openLink: 'com.boardsesh.app://dev/stories/climbs--populated?shot=123&captureOrientation=landscape' },
      { tapOn: { text: '^Open$', optional: true } },
      { repeat: { times: 3, while: { visible: '.*Open in.*Boardsesh.*' }, commands: [{ tapOn: '^Open$' }] } },
      { assertNotVisible: { text: '.*Open in.*Boardsesh.*' } },
      { setOrientation: 'LANDSCAPE_LEFT' },
      { waitForAnimationToEnd: { timeout: 10000 } },
    ]);
  });
  it('requests portrait content readiness for phone captures', () => {
    const flow = iosStoryNavigationFlow(
      'com.boardsesh.app',
      'com.boardsesh.app://dev/stories/player--kilter?shot=123',
      'PORTRAIT',
    );
    expect(flow).toContain('captureOrientation=portrait');
    expect(flow).not.toContain('LANDSCAPE');
  });
});
