// Queue Sheet Opened's `from` and Up next count (Then-signposts, 2026-11-02).
import { afterEach, describe, expect, it } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { resetLastPickForTests, setLastPick } from '../last-pick-store';
import { queueSheetOpenContext } from '../queue-sheet-open-context';

function item(uuid: string): ClimbQueueItem {
  return { uuid, climb: { uuid: `climb-${uuid}`, name: uuid } } as unknown as ClimbQueueItem;
}

const current = item('cur');
const queue = [item('h1'), current, item('u1'), item('u2'), item('u3')];

function pickUnder(currentAtPick: string) {
  setLastPick({
    item: item('looked-at'),
    suggestionSource: null,
    commitOptions: undefined,
    mirrored: false,
    currentAtPick,
    wallAtPick: null,
    pickedAt: 0,
  });
}

afterEach(() => resetLastPickForTests());

describe('queueSheetOpenContext', () => {
  it('counts Up next as the sheet header does: after the current climb', () => {
    expect(queueSheetOpenContext({ queue, currentClimbQueueItem: current }).upNextCount).toBe(3);
  });

  it('counts from the History / Up next line with nothing current', () => {
    expect(queueSheetOpenContext({ queue, currentClimbQueueItem: null, historyCount: 2 }).upNextCount).toBe(3);
    expect(queueSheetOpenContext({ queue: [], currentClimbQueueItem: null }).upNextCount).toBe(0);
  });

  it("takes the player's word for whether it shows a preview", () => {
    // The player knows; its own preview need not be in the store (signed out, it isn't).
    expect(queueSheetOpenContext({ queue, currentClimbQueueItem: current }, true).from).toBe('preview');
    pickUnder('cur');
    expect(queueSheetOpenContext({ queue, currentClimbQueueItem: current }, false).from).toBe('current');
  });

  it("reads the bar's last pick without one: a preview while it stands", () => {
    expect(queueSheetOpenContext({ queue, currentClimbQueueItem: current }).from).toBe('current');
    pickUnder('cur');
    expect(queueSheetOpenContext({ queue, currentClimbQueueItem: current }).from).toBe('preview');
  });

  it('reads current once the queue moved on from the climb the pick was made under', () => {
    pickUnder('h1');
    expect(queueSheetOpenContext({ queue, currentClimbQueueItem: current }).from).toBe('current');
  });
});
