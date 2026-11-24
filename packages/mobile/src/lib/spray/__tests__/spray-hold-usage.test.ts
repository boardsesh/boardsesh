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
vi.mock('@boardsesh/graphql/operations/spray-walls', () => ({ GET_SPRAY_WALL_HOLD_USAGE_SUMMARY: 'holdUsageSummary' }));
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

beforeEach(() => {
  alert.calls.length = 0;
  request.mockReset();
  track.mockReset();
});

describe('fetchSprayHoldUsage', () => {
  it('uses the distinct server count instead of adding per-hold usages', async () => {
    request.mockResolvedValueOnce({
      sprayWallHoldUsageSummary: { publishedClimbCount: 2, draftClimbCount: 1 },
    });
    await expect(fetchSprayHoldUsage('wall-1', [4, 7, 9, 11, 4])).resolves.toEqual({
      publishedClimbCount: 2,
      draftClimbCount: 1,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith('holdUsageSummary', {
      wallUuid: 'wall-1',
      holdIds: [4, 7, 9, 11],
    });
  });

  it('counts saves above the old 500-hold batch boundary in one request', async () => {
    request.mockResolvedValueOnce({
      sprayWallHoldUsageSummary: { publishedClimbCount: 1, draftClimbCount: 0 },
    });
    const ids = Array.from({ length: 1500 }, (_, index) => index + 1);
    await expect(fetchSprayHoldUsage('wall-1', ids)).resolves.toEqual({
      publishedClimbCount: 1,
      draftClimbCount: 0,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith('holdUsageSummary', { wallUuid: 'wall-1', holdIds: ids });
  });

  it('returns zero without requesting an empty removal', async () => {
    await expect(fetchSprayHoldUsage('wall-1', [])).resolves.toEqual({
      publishedClimbCount: 0,
      draftClimbCount: 0,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['offline', 'Cannot query field "sprayWallHoldUsageSummary" on type "Query".'])(
    'answers null when the read fails: %s',
    async (message) => {
      request.mockRejectedValueOnce(new Error(message));
      await expect(fetchSprayHoldUsage('wall-1', [4])).resolves.toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
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
