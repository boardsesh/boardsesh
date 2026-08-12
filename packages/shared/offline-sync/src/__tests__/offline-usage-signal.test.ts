import { describe, it, expect, vi } from 'vitest';
import { createOfflineUsageSignal, type OfflineUsageEmission } from '../telemetry/offline-usage-signal';

// The rollup gate behind the offline north-star (#4317). Search fires per
// keystroke, so this has to suppress the overwhelming majority of reads while
// still guaranteeing the FIRST qualifying read of a day emits — the headline
// metric is weekly unique users, and a user who only ever reads once must count.

const DAY_MS = 86_400_000;

function createHarness(options?: { ladder?: readonly number[]; maxEmitsPerDay?: number; startAt?: number }) {
  const emissions: OfflineUsageEmission[] = [];
  let clock = options?.startAt ?? DAY_MS * 20_000;
  const signal = createOfflineUsageSignal({
    emit: (emission) => emissions.push(emission),
    now: () => clock,
    ladder: options?.ladder,
    maxEmitsPerDay: options?.maxEmitsPerDay,
  });
  return {
    emissions,
    signal,
    advance(ms: number) {
      clock += ms;
    },
  };
}

const kilterSearch = { lane: 'offline_local', surface: 'search', boardName: 'kilter' } as const;

describe('createOfflineUsageSignal', () => {
  it('emits on the first read of a day with readCount 1', () => {
    const { signal, emissions } = createHarness();

    signal.recordRead(kilterSearch);

    expect(emissions).toEqual([
      { kind: 'served', lane: 'offline_local', surface: 'search', boardName: 'kilter', readCount: 1 },
    ]);
  });

  it('suppresses every read between ladder rungs', () => {
    const { signal, emissions } = createHarness();

    for (let read = 0; read < 9; read += 1) signal.recordRead(kilterSearch);

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.readCount).toBe(1);
  });

  it('emits again at the 10th and 100th read', () => {
    const { signal, emissions } = createHarness();

    for (let read = 0; read < 100; read += 1) signal.recordRead(kilterSearch);

    expect(emissions.map((emission) => emission.readCount)).toEqual([1, 10, 100]);
  });

  it('counts each lane independently', () => {
    const { signal, emissions } = createHarness();

    signal.recordRead(kilterSearch);
    signal.recordRead({ ...kilterSearch, lane: 'network_error_local' });
    signal.recordRead({ ...kilterSearch, lane: 'online_local' });

    expect(emissions.map((emission) => emission.kind === 'served' && emission.lane)).toEqual([
      'offline_local',
      'network_error_local',
      'online_local',
    ]);
  });

  it('counts each board independently', () => {
    const { signal, emissions } = createHarness();

    signal.recordRead(kilterSearch);
    signal.recordRead({ ...kilterSearch, boardName: 'tension' });

    expect(emissions).toHaveLength(2);
    expect(emissions.map((emission) => emission.boardName)).toEqual(['kilter', 'tension']);
  });

  // `surface` is descriptive, not part of the key — including it would roughly
  // triple the volume for a breakdown nobody has asked for yet.
  it('does not key on surface, and reports the surface that crossed the rung', () => {
    const { signal, emissions } = createHarness();

    signal.recordRead(kilterSearch);
    signal.recordRead({ ...kilterSearch, surface: 'climb_detail' });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.surface).toBe('search');
  });

  it('re-arms when the UTC epoch day rolls over', () => {
    const harness = createHarness();

    harness.signal.recordRead(kilterSearch);
    harness.signal.recordRead(kilterSearch);
    harness.advance(DAY_MS);
    harness.signal.recordRead(kilterSearch);

    expect(harness.emissions.map((emission) => emission.readCount)).toEqual([1, 1]);
  });

  it('does not re-arm within the same day', () => {
    const harness = createHarness();

    harness.signal.recordRead(kilterSearch);
    harness.advance(DAY_MS / 2);
    harness.signal.recordRead(kilterSearch);

    expect(harness.emissions).toHaveLength(1);
  });

  // Without this, a same-day account switch inherits the previous user's
  // counters and the new user's first offline day silently never fires.
  it('re-arms after reset()', () => {
    const { signal, emissions } = createHarness();

    signal.recordRead(kilterSearch);
    signal.recordRead(kilterSearch);
    signal.reset();
    signal.recordRead(kilterSearch);

    expect(emissions.map((emission) => emission.readCount)).toEqual([1, 1]);
  });

  it('records unavailable reads on their own keys, split by reason', () => {
    const { signal, emissions } = createHarness();

    signal.recordUnavailable({ reason: 'board_not_downloaded', surface: 'search', boardName: 'kilter' });
    signal.recordUnavailable({ reason: 'board_not_downloaded', surface: 'search', boardName: 'kilter' });
    signal.recordUnavailable({ reason: 'filter_unsupported', surface: 'search', boardName: 'kilter' });

    expect(emissions).toEqual([
      { kind: 'unavailable', reason: 'board_not_downloaded', surface: 'search', boardName: 'kilter', readCount: 1 },
      { kind: 'unavailable', reason: 'filter_unsupported', surface: 'search', boardName: 'kilter', readCount: 1 },
    ]);
  });

  it('does not let a served read and an unavailable read share a counter', () => {
    const { signal, emissions } = createHarness();

    signal.recordRead(kilterSearch);
    signal.recordUnavailable({ reason: 'board_not_downloaded', surface: 'search', boardName: 'kilter' });

    expect(emissions.map((emission) => emission.kind)).toEqual(['served', 'unavailable']);
  });

  // Backstop against a future call site turning this into a firehose.
  it('stops emitting once maxEmitsPerDay is reached, until reset()', () => {
    const { signal, emissions } = createHarness({ ladder: [1], maxEmitsPerDay: 2 });

    signal.recordRead({ ...kilterSearch, boardName: 'kilter' });
    signal.recordRead({ ...kilterSearch, boardName: 'tension' });
    signal.recordRead({ ...kilterSearch, boardName: 'moonboard' });

    expect(emissions).toHaveLength(2);

    signal.reset();
    signal.recordRead({ ...kilterSearch, boardName: 'moonboard' });

    expect(emissions).toHaveLength(3);
  });

  // A phone can keep this process resident for weeks. A lifetime cap would
  // eventually mute the north-star for the heaviest offline users — the exact
  // silent under-count this signal exists to eliminate — so the cap is per day.
  it('lifts the emission cap when the day rolls over', () => {
    const harness = createHarness({ ladder: [1], maxEmitsPerDay: 1 });

    harness.signal.recordRead(kilterSearch);
    harness.signal.recordRead({ ...kilterSearch, boardName: 'tension' });
    expect(harness.emissions).toHaveLength(1);

    harness.advance(DAY_MS);
    harness.signal.recordRead(kilterSearch);

    expect(harness.emissions).toHaveLength(2);
  });

  // The gate is called from a read path — a broken emit binding must never
  // surface as a failed climb search.
  it('swallows a throwing emit', () => {
    const signal = createOfflineUsageSignal({
      emit: vi.fn(() => {
        throw new Error('analytics exploded');
      }),
    });

    expect(() => signal.recordRead(kilterSearch)).not.toThrow();
  });
});
