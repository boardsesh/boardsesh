import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Remove a hold that climbs use?": asked when published climbs use the holds,
 * asked in generic words when the usage could not be read, never asked for
 * holds only drafts use.
 */

type AlertButton = { text: string; style?: string; onPress?: () => void };
const alert = vi.hoisted(() => ({
  calls: [] as { title: string; body: string; buttons: AlertButton[]; options?: { onDismiss?: () => void } }[],
}));
const request = vi.hoisted(() => vi.fn());
const track = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Alert: {
    alert: (title: string, body: string, buttons: AlertButton[], options?: { onDismiss?: () => void }) => {
      alert.calls.push({ title, body, buttons, options });
    },
  },
}));
vi.mock('@boardsesh/graphql/operations/spray-walls', () => ({ GET_SPRAY_WALL_HOLD_USAGE: 'holdUsage' }));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../spray-telemetry', () => ({ trackSprayEvent: track }));

const { askBeforeRemovingUsedHolds, confirmRemovingUsedHolds, fetchSprayHoldUsage } =
  await import('../spray-hold-usage');

const t = (key: string, values?: { count: number }) => (values ? `${key}#${values.count}` : key);

function press(label: string) {
  const button = alert.calls.at(-1)?.buttons.find((candidate) => candidate.text === label);
  if (!button) throw new Error(`no ${label} button`);
  button.onPress?.();
}

function usageRows(rows: [number, number, number][]) {
  return {
    sprayWallHoldUsage: rows.map(([holdId, publishedClimbCount, draftClimbCount]) => ({
      holdId,
      publishedClimbCount,
      draftClimbCount,
    })),
  };
}

beforeEach(() => {
  alert.calls.length = 0;
  request.mockReset();
  track.mockReset();
});

describe('fetchSprayHoldUsage', () => {
  it('sums the counts over the holds', async () => {
    request.mockResolvedValueOnce(
      usageRows([
        [4, 2, 1],
        [7, 1, 0],
      ]),
    );
    await expect(fetchSprayHoldUsage('wall-1', [4, 7, 4])).resolves.toEqual({
      publishedClimbCount: 3,
      draftClimbCount: 1,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith('holdUsage', { wallUuid: 'wall-1', holdIds: [4, 7] });
  });

  it('asks in batches of 500, the server cap', async () => {
    request.mockResolvedValue(usageRows([]));
    const ids = Array.from({ length: 501 }, (_, index) => index + 1);
    await fetchSprayHoldUsage('wall-1', ids);
    expect(request).toHaveBeenCalledTimes(2);
    expect((request.mock.calls[1][1] as { holdIds: number[] }).holdIds).toEqual([501]);
  });

  it('answers null when the read fails', async () => {
    request.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchSprayHoldUsage('wall-1', [4])).resolves.toBeNull();
  });
});

describe('confirmRemovingUsedHolds', () => {
  it('asks with the count when published climbs use the holds, and goes on with "Remove anyway"', async () => {
    const answer = confirmRemovingUsedHolds({ publishedClimbCount: 3, draftClimbCount: 0 }, 2, t);
    expect(alert.calls).toHaveLength(1);
    expect(alert.calls[0].title).toBe('sprayHoldUsage.title');
    expect(alert.calls[0].body).toBe('sprayHoldUsage.body#3');
    press('sprayHoldUsage.removeAnyway');
    await expect(answer).resolves.toBe(true);
    expect(track).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ properties: { holdCount: 2, publishedClimbCount: 3, usageKnown: true } }),
    );
  });

  it('keeps the holds on "Keep holds", and counts nothing', async () => {
    const answer = confirmRemovingUsedHolds({ publishedClimbCount: 1, draftClimbCount: 0 }, 1, t);
    press('sprayHoldUsage.keep');
    await expect(answer).resolves.toBe(false);
    expect(track).not.toHaveBeenCalled();
  });

  it('keeps the holds when the alert is dismissed another way', async () => {
    const answer = confirmRemovingUsedHolds({ publishedClimbCount: 1, draftClimbCount: 0 }, 1, t);
    alert.calls[0].options?.onDismiss?.();
    await expect(answer).resolves.toBe(false);
  });

  it('asks nothing when only drafts use the holds', async () => {
    await expect(confirmRemovingUsedHolds({ publishedClimbCount: 0, draftClimbCount: 4 }, 1, t)).resolves.toBe(true);
    expect(alert.calls).toHaveLength(0);
  });

  it('asks in generic words when the usage could not be read', async () => {
    const answer = confirmRemovingUsedHolds(null, 1, t);
    expect(alert.calls[0].body).toBe('sprayHoldUsage.bodyUnknown');
    press('sprayHoldUsage.removeAnyway');
    await expect(answer).resolves.toBe(true);
    expect(track).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ properties: { holdCount: 1, publishedClimbCount: 0, usageKnown: false } }),
    );
  });
});

describe('askBeforeRemovingUsedHolds', () => {
  it('reads the usage, then asks, failing toward asking', async () => {
    request.mockRejectedValueOnce(new Error('offline'));
    const answer = askBeforeRemovingUsedHolds('wall-1', [4], t);
    await vi.waitFor(() => expect(alert.calls).toHaveLength(1));
    expect(alert.calls[0].body).toBe('sprayHoldUsage.bodyUnknown');
    press('sprayHoldUsage.keep');
    await expect(answer).resolves.toBe(false);
  });
});
