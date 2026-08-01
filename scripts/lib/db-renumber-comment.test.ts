import { describe, expect, it } from 'vitest';

import { STICKY_MARKER, renderRenumberWorkflowComment } from './db-renumber-comment.cjs';

const context = {
  serverUrl: 'https://github.com',
  owner: 'boardsesh',
  repo: 'boardsesh',
  runId: '123',
};

const successfulComment = `${STICKY_MARKER}\n\n### 🔢 Renumbered onto \`main\``;

function decide(overrides: Record<string, string> = {}) {
  return renderRenumberWorkflowComment({
    renumberStatus: 'renumbered',
    commentBody: successfulComment,
    validationOutcome: 'success',
    applyOutcome: 'success',
    reapplyOutcome: 'success',
    recheckOutcome: 'success',
    recheckOk: 'true',
    recheckReason: '',
    pushOutcome: 'success',
    context,
    ...overrides,
  });
}

describe('renderRenumberWorkflowComment', () => {
  it('posts the local renumber-success comment only after the force-push succeeds', () => {
    expect(decide()).toBe(successfulComment);
  });

  it('holds the branch when validation or proof-of-apply fails, without reusing success copy', () => {
    const heldOutcomes: Array<Record<string, string>> = [
      {
        validationOutcome: 'failure',
        applyOutcome: 'skipped',
        reapplyOutcome: 'skipped',
        recheckOutcome: 'skipped',
        pushOutcome: 'skipped',
      },
      {
        applyOutcome: 'failure',
        reapplyOutcome: 'skipped',
        recheckOutcome: 'skipped',
        pushOutcome: 'skipped',
      },
      { reapplyOutcome: 'failure', recheckOutcome: 'skipped', pushOutcome: 'skipped' },
    ];

    for (const overrides of heldOutcomes) {
      const body = decide(overrides);
      expect(body).toContain('Nothing was pushed.');
      expect(body).toContain('actions/runs/123');
      expect(body).not.toContain('Renumbered onto');
    }
  });

  it('treats skipped or empty proof outcomes under always() as held', () => {
    const skippedProofOutcomes: Array<Record<string, string>> = [
      { applyOutcome: 'skipped', pushOutcome: 'skipped' },
      { reapplyOutcome: '', pushOutcome: '' },
    ];

    for (const overrides of skippedProofOutcomes) {
      expect(decide(overrides)).toContain('Proof-of-apply was skipped');
    }
  });

  it('reports a final re-check rejection as a branch move or opt-out, without a push', () => {
    const body = decide({
      recheckOk: 'false',
      recheckReason: 'The branch moved during the final re-check.',
      pushOutcome: 'skipped',
    });

    expect(body).toContain('branch moved during the final re-check');
    expect(body).toContain('Nothing was pushed.');
    expect(body).not.toContain('Renumbered onto');
  });

  it('names a renumber:skip label that appears during the final re-check', () => {
    const body = decide({
      recheckOk: 'false',
      recheckReason: 'The `renumber:skip` label appeared during the final re-check.',
      pushOutcome: 'skipped',
    });

    expect(body).toContain('`renumber:skip` label appeared');
    expect(body).toContain('Nothing was pushed.');
  });

  it('reports a failed final re-check before considering the push outcome', () => {
    const body = decide({ recheckOutcome: 'failure', recheckOk: '', pushOutcome: 'skipped' });

    expect(body).toContain('final PR re-check failed');
    expect(body).toContain('Nothing was pushed.');
    expect(body).not.toContain('Renumbered onto');
  });

  it('reports a real force-push failure rather than claiming the local renumber landed', () => {
    const body = decide({ pushOutcome: 'failure' });

    expect(body).toContain('Force-pushing');
    expect(body).toContain('Nothing was pushed.');
    expect(body).not.toContain('Renumbered onto');
  });

  it('treats an empty/skipped push outcome under always() as held', () => {
    for (const pushOutcome of ['', 'skipped']) {
      expect(decide({ pushOutcome })).toContain('Nothing was pushed.');
    }
  });

  it('reports a cancelled force-push as held', () => {
    const body = decide({ pushOutcome: 'cancelled' });

    expect(body).toContain('step outcome: cancelled');
    expect(body).toContain('Nothing was pushed.');
  });

  it('falls back to a held comment when renumbering fails without script output', () => {
    const body = decide({ renumberStatus: '', commentBody: '' });

    expect(body).toContain('failed before it could finish');
    expect(body).toContain('actions/runs/123');
    expect(body).toContain('Nothing was pushed.');
  });

  it('preserves the script-produced blocked and no-op bodies', () => {
    const blocked = `${STICKY_MARKER}\n\n### 🚧 Couldn’t renumber this migration automatically\n\nNothing was pushed.`;
    const noOp = `${STICKY_MARKER}\n\n### ✅ Migration number is already free`;

    expect(decide({ renumberStatus: 'blocked', commentBody: blocked })).toBe(blocked);
    expect(decide({ renumberStatus: 'no-op', commentBody: noOp })).toBe(noOp);
  });
});
