// One test per class of exit from the bootstrap phase, asserting the funnel
// invariant directly: an armed attempt emits EXACTLY ONE terminal event, and an
// attempt that already reported emits none (issue #4316).
//
// The engine-level counterparts (a real pullSync against real SQLite) live in
// snapshot-bootstrap.test.ts under "pullSync bootstrap funnel invariant"; these
// pin the classification and the double-emit rules without a database.

import { describe, expect, it, vi } from 'vitest';
import { createDownloadFunnelGuard } from '../download-funnel-guard';
import { SnapshotWipedError } from '../snapshot-bootstrap';

function makeGuard(
  teardown: () => ReturnType<Parameters<typeof createDownloadFunnelGuard>[0]['teardownReason']> = () => null,
) {
  const report = vi.fn();
  return { report, guard: createDownloadFunnelGuard({ report, teardownReason: teardown }) };
}

describe('download funnel guard', () => {
  it('reports an unregistered exit as unknown-exit, at full severity', () => {
    // The case the guard exists for: a `break` nobody wired to a report. Simulated
    // by arming and closing with nothing in between, which is exactly what the
    // phase does when a future branch bails without reporting.
    const { report, guard } = makeGuard();
    guard.arm('kilter:1:5', 'download');
    guard.close();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: 'kilter:1:5',
        stage: 'download',
        reason: 'unknown-exit',
        // Not an abort and not expected: this is the one bucket that must reach
        // Sentry, because it means the phase has a hole in it.
        aborted: false,
        expected: false,
        attempt: 0,
      }),
    );
    // A cause with a message, not null — the funnel's errorMessage names the stage.
    const [{ cause }] = report.mock.calls[0] as [{ cause: unknown }];
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain('download');
  });

  it('carries the stage the attempt actually reached', () => {
    const { report, guard } = makeGuard();
    guard.arm('kilter:1:5', 'download');
    guard.enterStage('import');
    guard.close();

    expect(report).toHaveBeenCalledWith(expect.objectContaining({ stage: 'import', reason: 'unknown-exit' }));
  });

  it('attributes an unexplained exit during a teardown to the teardown, not to a defect', () => {
    // A pocketed phone is not a hole in the code. Same shape #4314's hand-written
    // sites emit, which keeps it out of Sentry.
    const { report, guard } = makeGuard(() => 'aborted-background');
    guard.arm('kilter:1:5', 'download');
    guard.close();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'aborted-background', aborted: true, expected: true, attempt: 0 }),
    );
  });

  it('stays silent when a report site already closed the funnel', () => {
    // The no-double-emit rule. Every explicit report in the phase settles the
    // guard through the shared wrapper, so the finally must add nothing.
    const { report, guard } = makeGuard();
    guard.arm('kilter:1:5', 'download');
    guard.settle('kilter:1:5');
    guard.close();

    expect(report).not.toHaveBeenCalled();
  });

  it('stays silent when the import succeeded', () => {
    // A successful import owes the funnel a Completed from the board-data loop,
    // not a Failed from here — and that Completed can land cycles later.
    const { report, guard } = makeGuard();
    guard.arm('kilter:1:5', 'import');
    guard.settle('kilter:1:5');
    guard.close();

    expect(report).not.toHaveBeenCalled();
  });

  it('ignores a settle for a different scope', () => {
    // The retrofit grades path reports for scopes this attempt never armed.
    const { report, guard } = makeGuard();
    guard.arm('kilter:1:5', 'download');
    guard.settle('tension:2:8');
    guard.close();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: 'kilter:1:5', reason: 'unknown-exit' }));
  });

  it('classifies an exception unwinding the phase and reports it once', () => {
    // The leading candidate for the silent device: a SQLite lock on one of the
    // writes that sit outside the import's own catch.
    const { report, guard } = makeGuard();
    guard.arm('kilter:1:5', 'download');
    guard.settleUncaught(new Error('Error code 5: database is locked'));
    guard.close();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'database-locked', aborted: false, expected: false, attempt: 0 }),
    );
  });

  it('marks a network exception expected so it lands as a warning, not an error', () => {
    const { report, guard } = makeGuard();
    guard.arm('kilter:1:5', 'download');
    guard.settleUncaught(new TypeError('Network request failed'));
    guard.close();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ reason: 'network', aborted: false, expected: true }));
  });

  it('reports an exception thrown during a teardown as an abort', () => {
    const { report, guard } = makeGuard(() => 'aborted-wipe');
    guard.arm('kilter:1:5', 'import');
    guard.settleUncaught(new Error('Error code 5: database is locked'));
    guard.close();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'aborted-wipe', aborted: true, expected: true, attempt: 0 }),
    );
  });

  it('reports a SnapshotWipedError as an abort even after the flags cleared', () => {
    // The error IS the proof the cycle was torn down; the live flags may have
    // moved on by the time it unwinds.
    const { report, guard } = makeGuard(() => null);
    guard.arm('kilter:1:5', 'import');
    guard.settleUncaught(new SnapshotWipedError());
    guard.close();

    expect(report).toHaveBeenCalledWith(expect.objectContaining({ reason: 'aborted-wipe', aborted: true }));
  });

  it('says nothing at all for a scope that never reached Started', () => {
    // Every `continue` above the Started emission — an ineligible scope, a
    // cooldown, a layout the export does not carry — must stay silent.
    const { report, guard } = makeGuard();
    guard.close();
    guard.settle('kilter:1:5');
    guard.settleUncaught(new Error('boom'));

    expect(report).not.toHaveBeenCalled();
  });

  it('does not carry an attempt over to the next scope', () => {
    const { report, guard } = makeGuard();
    guard.arm('kilter:1:5', 'download');
    guard.close();
    report.mockClear();
    // Second iteration: this scope never armed, so its close is a no-op.
    guard.close();

    expect(report).not.toHaveBeenCalled();
  });

  it('survives a headless caller with no reporter', () => {
    const guard = createDownloadFunnelGuard({ report: undefined, teardownReason: () => null });
    guard.arm('kilter:1:5', 'download');
    expect(() => guard.close()).not.toThrow();
  });
});
