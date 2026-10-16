import { describe, expect, it } from 'vitest';
import { createScopeDownloadProgress } from '../download-progress';

describe('whole-download progress', () => {
  it('assigns one monotonic fraction across transfer, imports, and finishing', () => {
    const tracker = createScopeDownloadProgress({ scopeKey: 'kilter:1:5', hasGrades: true, now: () => 0 });
    const phases = ['preparing', 'downloading', 'unpacking', 'grades', 'finishing'] as const;
    const fractions = phases.map((phase) => tracker.offer({ phase, phaseFraction: 1, queuedScopes: 0 })?.fraction);
    expect(fractions[0]).toBeCloseTo(0.01);
    expect(fractions[1]).toBeCloseTo(0.45);
    expect(fractions[2]).toBeCloseTo(0.76);
    expect(fractions[3]).toBeCloseTo(0.85);
    expect(fractions[4]).toBe(1);
  });

  it('gives the grades weight to unpacking when there is no grades artifact', () => {
    const tracker = createScopeDownloadProgress({ scopeKey: 'moonboard:1:1', hasGrades: false, now: () => 0 });
    expect(tracker.offer({ phase: 'unpacking', phaseFraction: 1, queuedScopes: 0 })?.fraction).toBeCloseTo(0.85);
  });

  it('starts a reused artifact at 45 percent', () => {
    const tracker = createScopeDownloadProgress({ scopeKey: 'kilter:1:5', hasGrades: true, now: () => 0 });
    expect(tracker.offer({ phase: 'unpacking', phaseFraction: 0, queuedScopes: 0 })?.fraction).toBeCloseTo(0.45);
  });

  it('emits queue changes even when no byte or percent changes', () => {
    const tracker = createScopeDownloadProgress({ scopeKey: 'kilter:1:5', hasGrades: true, now: () => 0 });
    tracker.offer({ phase: 'downloading', phaseFraction: 0.5, queuedScopes: 2 });
    expect(tracker.offer({ phase: 'downloading', phaseFraction: 0.5, queuedScopes: 1 })?.queuedScopes).toBe(1);
  });

  it('reports paged rows without claiming an overall fraction', () => {
    let now = 0;
    const tracker = createScopeDownloadProgress({ scopeKey: 'kilter:1:5', hasGrades: true, now: () => now });
    expect(
      tracker.offer({ phase: 'finishing', phaseFraction: null, queuedScopes: 0, rowsProcessed: 0 })?.fraction,
    ).toBeNull();
    now = 400;
    expect(
      tracker.offer({ phase: 'finishing', phaseFraction: null, queuedScopes: 0, rowsProcessed: 500 })?.rowsProcessed,
    ).toBe(500);
  });

  it('ignores a phase callback that arrives late', () => {
    const tracker = createScopeDownloadProgress({ scopeKey: 'kilter:1:5', hasGrades: true, now: () => 0 });
    tracker.offer({ phase: 'grades', phaseFraction: 0.5, queuedScopes: 0 });
    expect(tracker.offer({ phase: 'downloading', phaseFraction: 0, queuedScopes: 0 })).toBeNull();
    expect(tracker.offer({ phase: 'downloading', phaseFraction: null, queuedScopes: 0 })).toBeNull();
  });

  it('allows a failed snapshot import to fall back to paged download rows', () => {
    const tracker = createScopeDownloadProgress({ scopeKey: 'kilter:1:5', hasGrades: true, now: () => 0 });
    tracker.offer({ phase: 'unpacking', phaseFraction: 0.5, queuedScopes: 0 });
    const paged = tracker.offer({ phase: 'downloading', phaseFraction: null, queuedScopes: 0, rowsProcessed: 500 });
    expect(paged?.phase).toBe('downloading');
    expect(paged?.fraction).toBeNull();
    expect(paged?.rowsProcessed).toBe(500);
  });

  it('suppresses every callback after cancellation, including phase changes', () => {
    const tracker = createScopeDownloadProgress({ scopeKey: 'kilter:1:5', hasGrades: true, now: () => 0 });
    tracker.cancel();
    expect(tracker.offer({ phase: 'finishing', phaseFraction: 1, queuedScopes: 0 })).toBeNull();
  });
  it('emits changed pending identities when their count stays equal', () => {
    const tracker = createScopeDownloadProgress({ scopeKey: 'kilter:1:5', hasGrades: true, now: () => 0 });
    tracker.offer({
      phase: 'downloading',
      phaseFraction: 0.5,
      queuedScopes: 1,
      pendingScopeKeys: ['kilter:1:5', 'tension:2:10'],
    });
    expect(
      tracker.offer({
        phase: 'downloading',
        phaseFraction: 0.5,
        queuedScopes: 1,
        pendingScopeKeys: ['kilter:1:5', 'moonboard:3:1'],
      })?.pendingScopeKeys,
    ).toEqual(['kilter:1:5', 'moonboard:3:1']);
  });
});
