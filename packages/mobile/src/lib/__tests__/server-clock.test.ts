import { beforeEach, describe, expect, it } from 'vitest';
import {
  SERVER_CLOCK_WINDOW_MS,
  getServerClockOffsetMs,
  localToServerMs,
  noteServerTimeFromEvent,
  noteServerTimeFromMutation,
  resetServerClock,
  serverToLocalMs,
} from '../server-clock';

// The server runs 5 s ahead of the phone throughout, so every estimate below
// should land on (or just under) 5000.
const SKEW_MS = 5_000;
const T0 = 1_800_000_000_000;

beforeEach(() => {
  resetServerClock();
});

describe('before any sample', () => {
  it('has no estimate and treats the two clocks as equal', () => {
    expect(getServerClockOffsetMs()).toBeNull();
    expect(serverToLocalMs(T0)).toBe(T0);
    expect(localToServerMs(T0)).toBe(T0);
  });
});

describe('event samples', () => {
  it('takes the fastest frame as the offset: latency only ever hides skew', () => {
    // Stamped on the server, received 300 ms later on the phone.
    noteServerTimeFromEvent({ serverNowMs: T0 + SKEW_MS, receivedAtMs: T0 + 300 });
    expect(getServerClockOffsetMs()).toBe(SKEW_MS - 300);
    noteServerTimeFromEvent({ serverNowMs: T0 + 1_000 + SKEW_MS, receivedAtMs: T0 + 1_000 + 40 });
    expect(getServerClockOffsetMs()).toBe(SKEW_MS - 40);
    // A slower frame later never pulls the estimate back down.
    noteServerTimeFromEvent({ serverNowMs: T0 + 2_000 + SKEW_MS, receivedAtMs: T0 + 2_000 + 900 });
    expect(getServerClockOffsetMs()).toBe(SKEW_MS - 40);
  });

  it('forgets samples older than five minutes once a newer one lands', () => {
    noteServerTimeFromEvent({ serverNowMs: T0 + SKEW_MS, receivedAtMs: T0 + 10 });
    const later = T0 + SERVER_CLOCK_WINDOW_MS + 1;
    noteServerTimeFromEvent({ serverNowMs: later + SKEW_MS, receivedAtMs: later + 500 });
    expect(getServerClockOffsetMs()).toBe(SKEW_MS - 500);
  });

  it('keeps the last estimate through a quiet spell rather than resetting', () => {
    noteServerTimeFromEvent({ serverNowMs: T0 + SKEW_MS, receivedAtMs: T0 + 100 });
    // Nothing new arrives; the estimate stands.
    expect(serverToLocalMs(T0 + 60_000 + SKEW_MS)).toBe(T0 + 60_000 + 100);
  });

  it('ignores a sample that is not a number', () => {
    noteServerTimeFromEvent({ serverNowMs: Number.NaN, receivedAtMs: T0 });
    expect(getServerClockOffsetMs()).toBeNull();
  });
});

describe('mutation samples', () => {
  it('uses the round trip midpoint', () => {
    // Sent at T0, answered 600 ms later; the server read its clock halfway.
    noteServerTimeFromMutation({ serverNowMs: T0 + 300 + SKEW_MS, sentAtMs: T0, receivedAtMs: T0 + 600 });
    expect(getServerClockOffsetMs()).toBe(SKEW_MS);
  });

  it('prefers the shortest round trip', () => {
    noteServerTimeFromMutation({ serverNowMs: T0 + 100 + SKEW_MS, sentAtMs: T0, receivedAtMs: T0 + 1_000 });
    noteServerTimeFromMutation({
      serverNowMs: T0 + 2_000 + 50 + SKEW_MS,
      sentAtMs: T0 + 2_000,
      receivedAtMs: T0 + 2_000 + 100,
    });
    expect(getServerClockOffsetMs()).toBe(SKEW_MS);
  });

  it('is clamped by what a fast event frame proves', () => {
    // The midpoint says 4900, but a frame that took 50 ms proves at least 4950.
    noteServerTimeFromMutation({ serverNowMs: T0 + SKEW_MS, sentAtMs: T0 - 200, receivedAtMs: T0 + 200 + 200 });
    noteServerTimeFromEvent({ serverNowMs: T0 + 1_000 + SKEW_MS, receivedAtMs: T0 + 1_000 + 50 });
    expect(getServerClockOffsetMs()).toBe(SKEW_MS - 50);
  });

  it('falls back to the best round trip when the bounds cross (the phone clock stepped)', () => {
    noteServerTimeFromEvent({ serverNowMs: T0 + SKEW_MS + 60_000, receivedAtMs: T0 });
    noteServerTimeFromMutation({ serverNowMs: T0 + 1_100 + SKEW_MS, sentAtMs: T0 + 1_000, receivedAtMs: T0 + 1_200 });
    expect(getServerClockOffsetMs()).toBe(SKEW_MS);
  });

  it('converts both ways with the estimate', () => {
    noteServerTimeFromMutation({ serverNowMs: T0 + 300 + SKEW_MS, sentAtMs: T0, receivedAtMs: T0 + 600 });
    expect(serverToLocalMs(T0 + SKEW_MS)).toBe(T0);
    expect(localToServerMs(T0)).toBe(T0 + SKEW_MS);
  });

  it('refuses a reply that arrived before it was sent', () => {
    noteServerTimeFromMutation({ serverNowMs: T0, sentAtMs: T0 + 10, receivedAtMs: T0 });
    expect(getServerClockOffsetMs()).toBeNull();
  });
});

describe('resetServerClock', () => {
  it('forgets every sample', () => {
    noteServerTimeFromEvent({ serverNowMs: T0 + SKEW_MS, receivedAtMs: T0 });
    resetServerClock();
    expect(getServerClockOffsetMs()).toBeNull();
  });
});
