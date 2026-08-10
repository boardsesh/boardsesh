/**
 * The comment decision used by db-migration-renumber.yml.
 *
 * This stays dependency-free CommonJS so `actions/github-script` can load it
 * from the checked-out default-branch tooling even when installing the PR's
 * dependencies or proving its migrations has failed.
 */

const STICKY_MARKER = '<!-- db-renumber -->';

function runUrl({ serverUrl, owner, repo, runId }) {
  return `${serverUrl}/${owner}/${repo}/actions/runs/${runId}`;
}

function heldBody(context, detail) {
  return [
    STICKY_MARKER,
    '',
    '### 🚧 Renumbering was held',
    '',
    detail,
    '',
    `See the [run log](${runUrl(context)}). Nothing was pushed.`,
  ].join('\n');
}

function failedStepState(outcome) {
  if (outcome === 'failure') return 'failed';
  if (outcome === 'skipped' || !outcome) return 'was skipped';
  return `did not succeed (step outcome: ${outcome})`;
}

/**
 * PURE: decide which sticky comment truthfully describes the action outcome.
 *
 * GitHub exposes `outcome` even for steps reached through `always()`; absent
 * outputs must still be treated as held rather than as evidence of a push.
 */
function renderRenumberWorkflowComment(input) {
  const {
    renumberStatus,
    commentBody,
    validationOutcome,
    applyOutcome,
    reapplyOutcome,
    recheckOutcome,
    recheckOk,
    recheckReason,
    pushOutcome,
    context,
  } = input;

  if (renumberStatus !== 'renumbered') {
    return commentBody || heldBody(context, 'The renumber job failed before it could finish.');
  }

  // Load-bearing precedence: a successful push is the terminal fact. The
  // workflow places this step after every proof step and its `if` keeps
  // GitHub's implicit success() guard, so contradictory earlier outcomes are
  // unreachable. Keep this first so we never claim "Nothing was pushed" after
  // the branch was actually updated.
  if (pushOutcome === 'success') {
    return (
      commentBody ||
      [
        STICKY_MARKER,
        '',
        '### ✅ Renumbered migration pushed',
        '',
        `The renumbered branch was pushed. See the [run log](${runUrl(context)}).`,
      ].join('\n')
    );
  }

  if (validationOutcome !== 'success') {
    return heldBody(
      context,
      `Migration-folder validation ${failedStepState(validationOutcome)} after local renumbering.`,
    );
  }

  if (applyOutcome !== 'success' || reapplyOutcome !== 'success') {
    const state = failedStepState(applyOutcome !== 'success' ? applyOutcome : reapplyOutcome);
    return heldBody(context, `Proof-of-apply ${state} after local renumbering.`);
  }

  if (recheckOutcome !== 'success') {
    return heldBody(context, `The final PR re-check ${failedStepState(recheckOutcome)} after local renumbering.`);
  }

  if (recheckOk !== 'true') {
    return heldBody(context, recheckReason || 'The PR changed or was opted out during the final re-check.');
  }

  return heldBody(context, `The force-push ${failedStepState(pushOutcome)} after local renumbering.`);
}

module.exports = { STICKY_MARKER, renderRenumberWorkflowComment };
