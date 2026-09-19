import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchKilterLiveHistory, normalizeKilterDisplayTime, parseKilterLiveHistory } from '../live-history';

const selection = { gymUuid: '780543', productLayoutUuid: '28', wallUuid: 'wall' };
const entry = {
  climbUuid: 'climb',
  angle: 20,
  derivativeAngle: 50,
  recentlyDisplayedAt: '2026-09-18 09:20:25.397501+00',
  recentlyDisplayedClimbId: 391419,
};

afterEach(() => vi.unstubAllGlobals());
describe('Kilter live history', () => {
  it('normalizes observed timestamps without losing occurrence precision', () => {
    expect(normalizeKilterDisplayTime(entry.recentlyDisplayedAt)).toBe('2026-09-18T09:20:25.397501Z');
    expect(normalizeKilterDisplayTime('2026-09-18T11:20:25.397501+02:00')).toBe('2026-09-18T09:20:25.397501Z');
    expect(normalizeKilterDisplayTime('2026-09-18 09:20:25')).toBeNull();
  });
  it('deduplicates polling but retains later occurrences of the same upstream row', () => {
    const displays = parseKilterLiveHistory(
      [entry, entry, { ...entry, recentlyDisplayedAt: '2026-09-18T09:21:00Z' }],
      selection,
    );
    expect(displays).toHaveLength(2);
    expect(displays[0]).toMatchObject({ angle: 50, displayName: null });
    expect(displays[0].occurrenceKey).not.toBe(displays[1].occurrenceKey);
  });
  it('never attributes a display to the setter and scopes fallback keys to the wall', () => {
    const [display] = parseKilterLiveHistory(
      [{ ...entry, recentlyDisplayedClimbId: null, username: 'setter' }],
      selection,
    );
    const [other] = parseKilterLiveHistory([{ ...entry, recentlyDisplayedClimbId: null }], {
      ...selection,
      wallUuid: 'other',
    });
    expect(display.displayName).toBeNull();
    expect(display.occurrenceKey).not.toBe(other.occurrenceKey);
  });
  it('skips invalid and hidden rows without rejecting valid neighbors', () => {
    expect(
      parseKilterLiveHistory(
        [
          null,
          { ...entry, isDeleted: true },
          { ...entry, recentlyDisplayedReported: true },
          { ...entry, recentlyDisplayedAt: null },
          { ...entry, derivativeAngle: null, angle: null },
          entry,
        ],
        selection,
      ),
    ).toHaveLength(1);
    expect(() => parseKilterLiveHistory({ data: [] }, selection)).toThrow('not an array');
  });
  it('calls only the read endpoint and exposes retry-after failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchKilterLiveHistory('token', selection)).rejects.toMatchObject({
      httpStatus: 429,
      retryAfterMs: 60000,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://portal.kiltergrips.com/api/recently-displayed-climbs/climbs',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(selection) }),
    );
  });
});
