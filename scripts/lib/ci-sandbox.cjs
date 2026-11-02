/**
 * Sandbox refs for workflow runs that must execute pull-request code.
 *
 * A run on the default branch can write entries every other branch and PR later
 * reads, so a default-branch run never executes PR-authored code. When a trusted
 * default-branch run decides a PR needs that work (an OTA preview publish, a
 * migration renumber), it hands the job to a fresh run on a throwaway branch,
 * `ci-sandbox/<workflow>/pr-<number>/<run id>`, that points at the same trusted
 * commit. That run executes the same workflow file, but everything it writes is
 * scoped to a ref nothing else reads, and the ref is deleted when the run ends.
 *
 * Dependency-free CommonJS so `actions/github-script` can load it from a sparse
 * checkout of the immutable workflow commit.
 */

const SANDBOX_ROOT = 'ci-sandbox';
const WORKFLOW_KEY = /^[a-z0-9][a-z0-9-]*$/;
const PR_NUMBER = /^[1-9][0-9]*$/;
const RUN_ID = /^[1-9][0-9]*$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** PURE: `ci-sandbox/<workflowKey>/pr-<number>/`, without `refs/heads/`. */
function sandboxPrefix(workflowKey, prNumber) {
  if (!WORKFLOW_KEY.test(String(workflowKey))) throw new Error(`Invalid sandbox workflow key '${workflowKey}'.`);
  if (!PR_NUMBER.test(String(prNumber))) throw new Error(`Invalid sandbox PR number '${prNumber}'.`);
  return `${SANDBOX_ROOT}/${workflowKey}/pr-${prNumber}/`;
}

/** PURE: true when `ref` is a sandbox branch for exactly this workflow and PR. */
function isSandboxRef(ref, workflowKey, prNumber) {
  if (typeof ref !== 'string') return false;
  let prefix;
  try {
    prefix = `refs/heads/${sandboxPrefix(workflowKey, prNumber)}`;
  } catch {
    return false;
  }
  return ref.startsWith(prefix) && RUN_ID.test(ref.slice(prefix.length));
}

/** PURE: true when `ref` is any sandbox branch for this workflow. */
function isAnySandboxRef(ref, workflowKey) {
  if (typeof ref !== 'string' || !WORKFLOW_KEY.test(String(workflowKey))) return false;
  const match = /^refs\/heads\/ci-sandbox\/([a-z0-9-]+)\/pr-([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(ref);
  return match !== null && match[1] === workflowKey;
}

async function deleteRef(github, context, ref) {
  try {
    await github.rest.git.deleteRef({ ...context.repo, ref: ref.replace(/^refs\//, '') });
  } catch (error) {
    // Already gone: a concurrent cleanup or the branch sweep got there first.
    if (error?.status !== 404 && error?.status !== 422) throw error;
  }
}

/**
 * Create a fresh sandbox branch at `sha` and dispatch `workflowFile` on it.
 *
 * Callers run inside a per-PR concurrency group, so every older sandbox for the
 * same PR belongs to a run that already finished or was replaced while pending;
 * those refs are removed first.
 */
async function handOffToSandbox({ github, context, core, workflowKey, workflowFile, prNumber, inputs, sha }) {
  if (!COMMIT_SHA.test(String(sha))) throw new Error(`Sandbox needs a full commit SHA, got '${sha}'.`);
  if (!RUN_ID.test(String(context.runId))) throw new Error(`Invalid run id '${context.runId}'.`);
  const prefix = sandboxPrefix(workflowKey, prNumber);
  const stale = await github.paginate(github.rest.git.listMatchingRefs, { ...context.repo, ref: `heads/${prefix}` });
  for (const { ref } of stale) {
    if (typeof ref === 'string' && ref.startsWith(`refs/heads/${prefix}`)) await deleteRef(github, context, ref);
  }
  const branch = `${prefix}${context.runId}`;
  await github.rest.git.createRef({ ...context.repo, ref: `refs/heads/${branch}`, sha });
  try {
    await github.rest.actions.createWorkflowDispatch({
      ...context.repo,
      workflow_id: workflowFile,
      ref: branch,
      inputs,
    });
  } catch (error) {
    await deleteRef(github, context, `refs/heads/${branch}`);
    throw error;
  }
  core.notice(`PR #${prNumber}: handed off to ${branch} (${sha.slice(0, 7)}).`);
  return branch;
}

/** Delete the sandbox branch this run is executing on. A no-op anywhere else. */
async function deleteOwnSandbox({ github, context, core, workflowKey }) {
  if (!isAnySandboxRef(context.ref, workflowKey)) {
    core.info(`Not a ${workflowKey} sandbox run (${context.ref}); nothing to delete.`);
    return false;
  }
  await deleteRef(github, context, context.ref);
  core.info(`Deleted ${context.ref}.`);
  return true;
}

module.exports = {
  SANDBOX_ROOT,
  sandboxPrefix,
  isSandboxRef,
  isAnySandboxRef,
  handOffToSandbox,
  deleteOwnSandbox,
};
