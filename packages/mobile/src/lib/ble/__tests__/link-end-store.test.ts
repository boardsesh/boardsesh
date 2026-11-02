// Board plan item 8: how this phone's last link ended, read once by the drive's watcher.
import { afterEach, describe, expect, it } from 'vitest';
import { LINK_END_FRESH_MS, noteLinkEnded, resetLinkEndForTests, takeLinkEnd } from '../link-end-store';

afterEach(() => resetLinkEndForTests());

describe('link-end-store', () => {
  it('hands the last end over once', () => {
    noteLinkEnded({ deliberate: false }, 1_000);
    expect(takeLinkEnd(1_100)).toEqual({ deliberate: false, takenByPeer: false, at: 1_000 });
    expect(takeLinkEnd(1_200)).toBeNull();
  });

  it('keeps only the latest end', () => {
    noteLinkEnded({ deliberate: false }, 1_000);
    noteLinkEnded({ deliberate: false, takenByPeer: true }, 1_500);
    expect(takeLinkEnd(1_600)).toEqual({ deliberate: false, takenByPeer: true, at: 1_500 });
  });

  it('drops an end too old to belong to the link that just went', () => {
    noteLinkEnded({ deliberate: false }, 1_000);
    expect(takeLinkEnd(1_000 + LINK_END_FRESH_MS)).not.toBeNull();
    noteLinkEnded({ deliberate: false }, 1_000);
    expect(takeLinkEnd(1_000 + LINK_END_FRESH_MS + 1)).toBeNull();
  });
});
