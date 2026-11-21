// Trusted control plane. PR code only runs in the secret-free sandbox build.
const { execFileSync } = require('node:child_process');
const {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { handOffToSandbox } = require('./ci-sandbox.cjs');

const BUILD_WORKFLOW = 'expo-web-preview.yml';
const REQUEST_TASK = 'expo-web-preview-request';
const PREVIEW_TASK = 'expo-web-preview';
const COMMENT_MARKER = '<!-- boardsesh:expo-web-preview -->';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SANDBOX_PATTERN = /^ci-sandbox\/web-preview\/pr-([1-9][0-9]*)\/([1-9][0-9]*)$/;
const REFRESH_AFTER_MS = 21 * 24 * 60 * 60 * 1000;

function prNumber(input) {
  if (!/^[1-9][0-9]*$/.test(String(input)) || !Number.isSafeInteger(Number(input))) {
    throw new Error('A positive PR number is required.');
  }
  return Number(input);
}

function repositoryName(context) {
  return `${context.repo.owner}/${context.repo.repo}`;
}

function environment(number) {
  return `expo-web-preview-${prNumber(number)}`;
}

function requestEnvironment(number) {
  return `expo-web-preview-request-${prNumber(number)}`;
}

function isBot(deployment) {
  return deployment.creator?.login === 'github-actions[bot]';
}

function payloadOf(deployment) {
  const payload = deployment.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  return {};
}

async function appInputs() {
  return import(pathToFileURL(join(__dirname, 'expo-web-inputs.mjs')).href);
}

async function cloudflareClient() {
  const { createCloudflareClient } = await import(
    pathToFileURL(join(__dirname, 'expo-web-preview-cloudflare.mjs')).href
  );
  return createCloudflareClient({
    token: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    zoneId: process.env.CLOUDFLARE_ZONE_ID || undefined,
    retireDeployment: (identity) => retirePreview(identity.prNumber),
  });
}

async function changedPaths(github, context, number) {
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...context.repo,
    pull_number: number,
    per_page: 100,
  });
  // GitHub caps this endpoint at 3000 files. Refuse a false negative.
  if (files.length >= 3000) throw new Error('PR exceeds the complete changed-file listing limit. Split the PR.');
  return files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean));
}

async function getPullRequest(github, context, number) {
  const { data: pullRequest } = await github.rest.pulls.get({ ...context.repo, pull_number: prNumber(number) });
  if (pullRequest.base.repo.full_name !== repositoryName(context)) throw new Error('PR belongs to another repository.');
  return pullRequest;
}

async function hasAppChanges(github, context, number) {
  const { hasAppAffectingChanges } = await appInputs();
  return hasAppAffectingChanges(await changedPaths(github, context, number));
}

function targetsDefaultBranch(pullRequest, context) {
  const defaultBranch = context.payload.repository?.default_branch;
  return typeof defaultBranch === 'string' && pullRequest.base.ref === defaultBranch;
}

async function currentHead(github, context, number, sha, headRepository) {
  const pullRequest = await getPullRequest(github, context, number);
  return (
    pullRequest.state === 'open' &&
    targetsDefaultBranch(pullRequest, context) &&
    pullRequest.head.sha === sha &&
    pullRequest.head.repo?.full_name === headRepository &&
    (await hasAppChanges(github, context, number))
  );
}

async function comment(github, context, number, message) {
  const body = `${COMMENT_MARKER}\n${message}\n\nUses production data; changes are real.`;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: number,
    per_page: 100,
  });
  const previous = comments.find(
    (entry) => entry.user?.login === 'github-actions[bot]' && entry.body?.startsWith(COMMENT_MARKER),
  );
  if (previous) {
    if (previous.body !== body)
      await github.rest.issues.updateComment({ ...context.repo, comment_id: previous.id, body });
  } else {
    await github.rest.issues.createComment({ ...context.repo, issue_number: number, body });
  }
}

async function deployments(github, context, number, task = PREVIEW_TASK) {
  return github.paginate(github.rest.repos.listDeployments, {
    ...context.repo,
    environment: task === REQUEST_TASK ? requestEnvironment(number) : environment(number),
    task,
    per_page: 100,
  });
}

async function retireRequests(github, context, number, exceptHead) {
  let hadRequests = false;
  for (const request of await deployments(github, context, number, REQUEST_TASK)) {
    if (!validRequest(request, number) || (exceptHead && request.sha === exceptHead)) continue;
    hadRequests = true;
    const { data: statuses } = await github.rest.repos.listDeploymentStatuses({
      ...context.repo,
      deployment_id: request.id,
      per_page: 1,
    });
    if (['pending', 'queued', 'in_progress'].includes(statuses[0]?.state)) {
      await updateDeployment(github, context, request.id, 'inactive', 'Preview request closed or superseded');
    }
  }
  return hadRequests;
}

async function latestPreview(github, context, number) {
  const candidates = (await deployments(github, context, number))
    .filter(
      (deployment) =>
        isBot(deployment) &&
        deployment.task === PREVIEW_TASK &&
        payloadOf(deployment).version === 1 &&
        payloadOf(deployment).prNumber === number,
    )
    .sort((left, right) => right.id - left.id);
  for (const deployment of candidates) {
    const { data: statuses } = await github.rest.repos.listDeploymentStatuses({
      ...context.repo,
      deployment_id: deployment.id,
      per_page: 1,
    });
    if (statuses[0]?.state === 'success') return deployment;
  }
  return null;
}

async function updateDeployment(github, context, deploymentId, state, description, url) {
  await github.rest.repos.createDeploymentStatus({
    ...context.repo,
    deployment_id: deploymentId,
    state,
    description: description.slice(0, 140),
    ...(url ? { environment_url: url } : {}),
    auto_inactive: false,
    log_url: `https://github.com/${repositoryName(context)}/actions/runs/${context.runId}`,
  });
}

async function appInputsUnchanged(github, context, deployedSha, headSha) {
  if (deployedSha === headSha) return true;
  if (!SHA_PATTERN.test(deployedSha)) return false;
  try {
    const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
      ...context.repo,
      basehead: `${deployedSha}...${headSha}`,
      per_page: 1,
    });
    // Diverged or capped comparisons cannot prove that the browser inputs match.
    if (
      !['ahead', 'identical'].includes(comparison.status) ||
      !Array.isArray(comparison.files) ||
      comparison.files.length >= 300
    )
      return false;
    const { hasAppAffectingChanges } = await appInputs();
    return !hasAppAffectingChanges(
      comparison.files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean)),
    );
  } catch (error) {
    if (error.status === 404 || error.status === 422) return false;
    throw error;
  }
}

async function previewServesRevision(number, sha, fetchPreview = globalThis.fetch) {
  try {
    const response = await fetchPreview(`https://pr-${prNumber(number)}.boardsesh.com/preview-meta.json`, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 200 || !/application\/json/i.test(response.headers.get('content-type') || '')) return false;
    const metadata = await response.json();
    return metadata?.prNumber === number && metadata?.sha === sha;
  } catch {
    return false;
  }
}

async function requireMaintainer(github, context, login) {
  const { data: permission } = await github.rest.repos.getCollaboratorPermissionLevel({
    ...context.repo,
    username: login,
  });
  if (!['write', 'maintain', 'admin'].includes(permission.permission))
    throw new Error('Publishing fork code requires repository write permission.');
}

async function createBuildRequest({
  github,
  context,
  core,
  pullRequest,
  trustedSha,
  commentId,
  previousPreview,
  handoff = handOffToSandbox,
}) {
  const number = prNumber(pullRequest.number);
  if (!SHA_PATTERN.test(trustedSha) || !SHA_PATTERN.test(pullRequest.head.sha))
    throw new Error('Full immutable source SHAs are required.');
  const sandboxRef = `ci-sandbox/web-preview/pr-${number}/${context.runId}`;
  const { data: request } = await github.rest.repos.createDeployment({
    ...context.repo,
    ref: pullRequest.head.sha,
    task: REQUEST_TASK,
    environment: requestEnvironment(number),
    auto_merge: false,
    required_contexts: [],
    transient_environment: true,
    production_environment: false,
    description: `Expo web preview request pr-${number}`,
    payload: {
      version: 1,
      prNumber: number,
      headSha: pullRequest.head.sha,
      headRepository: pullRequest.head.repo.full_name,
      trustedSha,
      sandboxRef,
      ...(commentId ? { commentId } : {}),
    },
  });
  await updateDeployment(github, context, request.id, 'in_progress', 'Building browser preview');
  await comment(
    github,
    context,
    number,
    `Browser preview is building revision \`${pullRequest.head.sha.slice(0, 7)}\`.` +
      (previousPreview
        ? ` [Previous preview](https://pr-${number}.boardsesh.com) · deployed revision \`${previousPreview.sha.slice(0, 7)}\`.`
        : ''),
  );
  try {
    await handoff({
      github,
      context,
      core,
      workflowKey: 'web-preview',
      workflowFile: BUILD_WORKFLOW,
      prNumber: String(number),
      sha: trustedSha,
      inputs: { pr: String(number), sha: pullRequest.head.sha, request: String(request.id) },
    });
  } catch (error) {
    await updateDeployment(github, context, request.id, 'failure', 'Could not start preview build');
    await comment(
      github,
      context,
      number,
      `Browser preview could not start. [Inspect the workflow](https://github.com/${repositoryName(context)}/actions/runs/${context.runId}).`,
    );
    throw error;
  }
  return request;
}

async function cleanupPreview({ github, context, core, number, cloudflare, force = false }) {
  const hadRequests = await retireRequests(github, context, number);
  const previous = await deployments(github, context, number);
  const hadPreview = previous.some((deployment) => isBot(deployment) && deployment.task === PREVIEW_TASK);
  if (force || hadPreview) {
    await (cloudflare || (await cloudflareClient())).removePreview(number);
    for (const deployment of previous.filter(isBot))
      await updateDeployment(github, context, deployment.id, 'inactive', 'Preview removed');
  }
  if (force || hadPreview || hadRequests) {
    await comment(
      github,
      context,
      number,
      'Browser preview removed: the PR is closed, targets another branch, or has no remaining app changes.',
    );
  }
  core.info(`Preview pr-${number} reconciled.`);
}

async function reconcilePullRequest(options) {
  const { github, context, core, number, force = false, commentId, cloudflare } = options;
  const pullRequest = await getPullRequest(github, context, number);
  if (
    pullRequest.state !== 'open' ||
    !targetsDefaultBranch(pullRequest, context) ||
    !(await hasAppChanges(github, context, number))
  ) {
    await cleanupPreview({ github, context, core, number, cloudflare, force: options.refresh });
    return 'cleanup';
  }
  if (!pullRequest.head.repo) throw new Error('PR source repository no longer exists.');
  const isFork = pullRequest.head.repo.full_name !== repositoryName(context);
  if (isFork && commentId && options.approvedSha !== pullRequest.head.sha)
    throw new Error('PR advanced after the fork approval was checked. Request the new full SHA.');
  await retireRequests(github, context, number, pullRequest.head.sha);
  const previous = await latestPreview(github, context, number);
  // A scheduled refresh may repeat an already approved SHA, never authorize a new one.
  const approvedRefresh =
    options.refresh && previous?.sha === pullRequest.head.sha && payloadOf(previous).forkApproved === true;
  if (isFork && !commentId && !approvedRefresh) {
    await comment(
      github,
      context,
      number,
      `Revision \`${pullRequest.head.sha.slice(0, 7)}\` needs a maintainer to request \`/web-preview ${pullRequest.head.sha}\` before it can be published.`,
    );
    return 'awaiting-approval';
  }
  if (
    !force &&
    previous &&
    (await appInputsUnchanged(github, context, previous.sha, pullRequest.head.sha)) &&
    (await previewServesRevision(number, previous.sha, options.fetchPreview))
  ) {
    await comment(
      github,
      context,
      number,
      `[Open browser preview](https://pr-${number}.boardsesh.com) · deployed revision \`${previous.sha.slice(0, 7)}\`. App inputs are unchanged; this preview is still current for the browser app.`,
    );
    return 'reuse';
  }
  await createBuildRequest({
    ...options,
    pullRequest,
    previousPreview: previous,
    commentId: commentId || payloadOf(previous || {}).commentId,
  });
  return 'build';
}

async function runLifecycle(options) {
  const { github, context, trustedSha, cloudflare } = options;
  if (!SHA_PATTERN.test(trustedSha)) throw new Error('Trusted workflow SHA is required.');
  const defaultBranch = context.payload.repository.default_branch;
  if (context.eventName === 'workflow_dispatch' && context.ref !== `refs/heads/${defaultBranch}`)
    throw new Error('Run preview requests on the default branch.');
  if (context.eventName === 'schedule') {
    const client = cloudflare || (await cloudflareClient());
    for (const preview of await client.listPreviews()) {
      const pullRequest = await getPullRequest(github, context, preview.prNumber);
      if (
        pullRequest.state !== 'open' ||
        !targetsDefaultBranch(pullRequest, context) ||
        !(await hasAppChanges(github, context, preview.prNumber))
      ) {
        // Per-PR dispatch shares the publisher's mutation lock, including orphans.
        await github.rest.actions.createWorkflowDispatch({
          ...context.repo,
          workflow_id: 'expo-web-preview-lifecycle.yml',
          ref: defaultBranch,
          inputs: { pr: String(preview.prNumber), refresh: 'true' },
        });
      } else if (!preview.createdOn || Date.now() - Date.parse(preview.createdOn) >= REFRESH_AFTER_MS) {
        // Dispatch the trusted per-PR lifecycle so renewal shares its mutation lock.
        await github.rest.actions.createWorkflowDispatch({
          ...context.repo,
          workflow_id: 'expo-web-preview-lifecycle.yml',
          ref: defaultBranch,
          inputs: { pr: String(preview.prNumber), refresh: 'true' },
        });
      }
    }
    return;
  }
  let number;
  let commentId;
  let approvedSha;
  if (context.eventName === 'issue_comment') {
    const command = /^\/web-preview(?:\s+([0-9a-f]{40}))?$/.exec(context.payload.comment.body.trim());
    if (!context.payload.issue.pull_request || !command) return;
    await requireMaintainer(github, context, context.payload.comment.user.login);
    number = prNumber(context.payload.issue.number);
    commentId = context.payload.comment.id;
    approvedSha = command[1];
    const pullRequest = await getPullRequest(github, context, number);
    if (
      (approvedSha && approvedSha !== pullRequest.head.sha) ||
      (pullRequest.head.repo?.full_name !== repositoryName(context) && approvedSha !== pullRequest.head.sha)
    ) {
      throw new Error(`Approval must name the current full SHA: /web-preview ${pullRequest.head.sha}`);
    }
  } else if (context.eventName === 'workflow_dispatch') {
    number = prNumber(context.payload.inputs.pr);
    // A dispatch is maintainer-only, but does not replace a fork's SHA-bound comment.
  } else if (context.eventName === 'pull_request_target') {
    number = prNumber(context.payload.pull_request.number);
  } else throw new Error('Unsupported preview lifecycle event.');
  const refresh = context.payload.inputs?.refresh === 'true';
  await reconcilePullRequest({
    ...options,
    number,
    commentId,
    approvedSha,
    refresh,
    force: Boolean(commentId) || context.eventName === 'workflow_dispatch',
  });
}

function validRequest(request, number) {
  const payload = payloadOf(request);
  return (
    isBot(request) &&
    request.task === REQUEST_TASK &&
    request.environment === requestEnvironment(number) &&
    payload.version === 1 &&
    payload.prNumber === number &&
    SHA_PATTERN.test(payload.headSha || '') &&
    request.sha === payload.headSha &&
    SHA_PATTERN.test(payload.trustedSha || '') &&
    typeof payload.headRepository === 'string'
  );
}

async function inspectBuild({ github, context, core }) {
  core.setOutput('build', 'false');
  const number = prNumber(context.payload.inputs.pr);
  const { data: request } = await github.rest.repos.getDeployment({
    ...context.repo,
    deployment_id: Number(context.payload.inputs.request),
  });
  const payload = payloadOf(request);
  if (
    context.eventName !== 'workflow_dispatch' ||
    !validRequest(request, number) ||
    context.ref !== `refs/heads/${payload.sandboxRef}` ||
    !SANDBOX_PATTERN.test(payload.sandboxRef) ||
    context.sha !== payload.trustedSha ||
    context.payload.inputs.sha !== payload.headSha
  )
    throw new Error('Build is not bound to a trusted sandbox request.');
  if (!(await currentHead(github, context, number, payload.headSha, payload.headRepository))) return;
  if (payload.headRepository !== repositoryName(context))
    await validateForkApproval(github, context, number, payload.commentId, payload.headSha);
  core.setOutput('head_sha', payload.headSha);
  core.setOutput('head_repository', payload.headRepository);
  core.setOutput('artifact', `expo-web-preview-${number}-${payload.headSha}`);
  core.setOutput('build', 'true');
}

async function validateForkApproval(github, context, number, commentId, sha) {
  if (!Number.isSafeInteger(commentId) || commentId <= 0) throw new Error('Fork preview has no maintainer approval.');
  const { data: approval } = await github.rest.issues.getComment({ ...context.repo, comment_id: commentId });
  if (
    approval.issue_url !== `https://api.github.com/repos/${repositoryName(context)}/issues/${number}` ||
    approval.body.trim() !== `/web-preview ${sha}`
  )
    throw new Error('Fork approval does not name this PR revision.');
  await requireMaintainer(github, context, approval.user.login);
}

async function loadSourceRun(github, context) {
  if (context.eventName === 'workflow_dispatch') {
    if (context.ref !== `refs/heads/${context.payload.repository.default_branch}`)
      throw new Error('Run preview publication on the default branch.');
    const runId = prNumber(context.payload.inputs.source_run_id);
    // The notifier runs before its own workflow completes. Wait for GitHub's
    // authoritative conclusion; the caller never supplies a build verdict.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: runId });
      context.payload.workflow_run = run;
      if (run.status === 'completed') return run;
      if (attempt < 24) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error('Source build did not finish within the publication wait budget. Retry the publisher dispatch.');
  }
  return context.payload.workflow_run;
}

async function sourceRequest(github, context) {
  await loadSourceRun(github, context);
  const run = context.payload.workflow_run;
  const sandbox = SANDBOX_PATTERN.exec(run.head_branch || '');
  const workflowPath = typeof run.path === 'string' ? run.path.split('@')[0] : '';
  if (
    run.event !== 'workflow_dispatch' ||
    run.repository.full_name !== repositoryName(context) ||
    workflowPath !== `.github/workflows/${BUILD_WORKFLOW}` ||
    !sandbox ||
    run.head_repository.full_name !== repositoryName(context)
  )
    return null;
  const number = prNumber(sandbox[1]);
  const requests = await deployments(github, context, number, REQUEST_TASK);
  const request = requests.find(
    (candidate) =>
      validRequest(candidate, number) &&
      payloadOf(candidate).sandboxRef === run.head_branch &&
      payloadOf(candidate).trustedSha === run.head_sha,
  );
  if (!request) throw new Error('Build has no matching trusted preview request.');
  const payload = payloadOf(request);
  if (!(await currentHead(github, context, number, payload.headSha, payload.headRepository))) return null;
  if (payload.headRepository !== repositoryName(context))
    await validateForkApproval(github, context, number, payload.commentId, payload.headSha);
  return { request, number, payload };
}

async function inspectPublish({ github, context, core, inspectOnly = false }) {
  core.setOutput('publish', 'false');
  const source = await sourceRequest(github, context);
  if (!source) return;
  const { request, number, payload } = source;
  core.setOutput('pr_number', String(number));
  const run = context.payload.workflow_run;
  if (run.conclusion !== 'success') {
    if (!inspectOnly) {
      await updateDeployment(github, context, request.id, 'failure', 'Browser preview build failed');
      await comment(
        github,
        context,
        number,
        `Browser preview failed for revision \`${payload.headSha.slice(0, 7)}\`. [Inspect the build](${run.html_url}).`,
      );
    }
    return;
  }
  const artifact = `expo-web-preview-${number}-${payload.headSha}`;
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    ...context.repo,
    run_id: run.id,
    per_page: 100,
  });
  if (!artifacts.some((entry) => entry.name === artifact && !entry.expired))
    throw new Error('Build completed without its expected browser artifact.');
  for (const [key, contents] of Object.entries({
    publish: 'true',
    pr_number: String(number),
    sha: payload.headSha,
    artifact,
    request_id: String(request.id),
    head_repository: payload.headRepository,
  }))
    core.setOutput(key, contents);
}

async function reportPublishFailure({ github, context, core }) {
  try {
    const source = await sourceRequest(github, context);
    if (!source) return;
    await updateDeployment(github, context, source.request.id, 'failure', 'Browser preview publication failed');
    await comment(
      github,
      context,
      source.number,
      `Browser preview could not be published for \`${source.payload.headSha.slice(0, 7)}\`. [Inspect the workflow](https://github.com/${repositoryName(context)}/actions/runs/${context.runId}).`,
    );
  } catch (error) {
    core.warning(`Could not report preview failure: ${error.message}`);
  }
}

function prepareArtifact(directory, trustedDirectory, number, sha, hostDirectory) {
  if (!SHA_PATTERN.test(sha)) throw new Error('Full preview source SHA is required.');
  const walk = (current) => {
    for (const filename of readdirSync(current)) {
      const path = join(current, filename);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new Error('Preview artifacts must contain only regular files and directories.');
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(directory);
  if (
    !existsSync(join(directory, 'index.html')) ||
    !existsSync(join(directory, '_expo')) ||
    !existsSync(join(directory, 'wasm', 'board_renderer_wasm_bg.wasm'))
  )
    throw new Error('Browser export is incomplete.');
  // These special files can execute server code or override trusted hosting policy.
  for (const filename of [
    '_worker.js',
    '_worker.js.map',
    'functions',
    'wrangler.toml',
    'wrangler.json',
    'wrangler.jsonc',
    '_headers',
    '_redirects',
    '_routes.json',
  ]) {
    rmSync(join(directory, filename), { recursive: true, force: true });
  }
  const hostingSource = join(trustedDirectory, 'deploy', 'app-subdomain');
  for (const filename of ['_headers', '_redirects', '_routes.json', 'robots.txt'])
    cpSync(join(hostingSource, filename), join(directory, filename));
  mkdirSync(hostDirectory, { recursive: true });
  cpSync(join(hostingSource, 'functions'), join(hostDirectory, 'functions'), { recursive: true });
  writeFileSync(join(directory, 'preview-meta.json'), `${JSON.stringify({ prNumber: prNumber(number), sha })}\n`);
}

async function uploadPagesArtifact({ directory, hostDirectory, number, sha, commitMessage = 'Expo web PR preview' }) {
  const numberToUpload = prNumber(number);
  if (!SHA_PATTERN.test(sha)) throw new Error('Full preview source SHA is required.');
  execFileSync(
    'vp',
    [
      'dlx',
      'wrangler@4',
      'pages',
      'deploy',
      directory,
      '--cwd',
      hostDirectory,
      '--project-name=boardsesh-app-previews',
      `--branch=pr-${numberToUpload}`,
      `--commit-hash=${sha}`,
      `--commit-message=${commitMessage}`,
    ],
    { stdio: 'inherit', cwd: hostDirectory, timeout: 10 * 60 * 1000 },
  );
}

async function retirePreview(
  number,
  { upload = uploadPagesArtifact, temporaryRoot = process.env.RUNNER_TEMP || tmpdir() } = {},
) {
  const previewNumber = prNumber(number);
  const { RETIRED_COMMIT_SHA, RETIRED_COMMIT_MESSAGE } = await import(
    pathToFileURL(join(__dirname, 'expo-web-preview-cloudflare.mjs')).href
  );
  const directory = mkdtempSync(join(temporaryRoot, 'expo-web-preview-retired-'));
  try {
    // The retained branch is inert trusted HTML: no app code, credentials,
    // functions, analytics or calls to the production backend survive cleanup.
    writeFileSync(
      join(directory, 'index.html'),
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, follow">' +
        '<title>Preview closed</title></head><body><h1>This preview is closed</h1>' +
        `<p><a href="https://github.com/boardsesh/boardsesh/pull/${previewNumber}">See the pull request</a> for its current status.</p></body></html>\n`,
    );
    writeFileSync(
      join(directory, '_headers'),
      '/*\n  X-Robots-Tag: noindex, follow\n  Cache-Control: no-store\n  X-Content-Type-Options: nosniff\n',
    );
    writeFileSync(join(directory, '_redirects'), '/* /index.html 200\n');
    writeFileSync(join(directory, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
    writeFileSync(
      join(directory, 'preview-meta.json'),
      `${JSON.stringify({ prNumber: previewNumber, retired: true })}\n`,
    );
    await upload({
      directory,
      hostDirectory: directory,
      number: previewNumber,
      sha: RETIRED_COMMIT_SHA,
      commitMessage: RETIRED_COMMIT_MESSAGE,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function publish(options) {
  const { github, context, core, directory, trustedDirectory, cloudflare, upload } = options;
  const source = await sourceRequest(github, context);
  if (!source || context.payload.workflow_run.conclusion !== 'success') return;
  const { request, number, payload } = source;
  const client = cloudflare || (await cloudflareClient());
  let deployment;
  try {
    await client.ensureProject();
    const hostDirectory = join(directory, '..', 'trusted-preview-host');
    prepareArtifact(directory, trustedDirectory, number, payload.headSha, hostDirectory);
    // Create the receipt before uploading so failed/canceled first deploys can be cleaned.
    ({ data: deployment } = await github.rest.repos.createDeployment({
      ...context.repo,
      ref: payload.headSha,
      task: PREVIEW_TASK,
      environment: environment(number),
      auto_merge: false,
      required_contexts: [],
      transient_environment: true,
      production_environment: false,
      description: `Expo web preview pr-${number}`,
      payload: {
        version: 1,
        prNumber: number,
        forkApproved: payload.headRepository !== repositoryName(context),
        commentId: payload.commentId,
      },
    }));
    await updateDeployment(github, context, deployment.id, 'in_progress', 'Publishing browser preview');
    const stillCurrent = () => currentHead(github, context, number, payload.headSha, payload.headRepository);
    const superseded = async () => {
      if (await stillCurrent()) return false;
      await updateDeployment(github, context, deployment.id, 'inactive', 'Preview publication superseded');
      await updateDeployment(github, context, request.id, 'inactive', 'Preview request superseded');
      return true;
    };
    if (await superseded()) return;
    await (upload || uploadPagesArtifact)({ directory, hostDirectory, number, sha: payload.headSha });
    if (await superseded()) return;
    await client.ensurePreviewDomain(number);
    const url = await client.smokePreview(number, payload.headSha);
    if (await superseded()) return;
    await updateDeployment(github, context, deployment.id, 'success', 'Browser preview is ready', url);
    await updateDeployment(github, context, request.id, 'success', 'Browser preview is ready', url);
    await comment(
      github,
      context,
      number,
      `[Open browser preview](${url}) · deployed revision \`${payload.headSha.slice(0, 7)}\`.`,
    );
    core.info(`Browser preview ready: ${url}`);
  } catch (error) {
    if (deployment)
      await updateDeployment(github, context, deployment.id, 'failure', 'Browser preview publication failed');
    await updateDeployment(github, context, request.id, 'failure', 'Browser preview publication failed');
    if (await currentHead(github, context, number, payload.headSha, payload.headRepository)) {
      await comment(
        github,
        context,
        number,
        `Browser preview could not be published for \`${payload.headSha.slice(0, 7)}\`. [Inspect the workflow](https://github.com/${repositoryName(context)}/actions/runs/${context.runId}).`,
      );
    }
    throw error;
  }
}

module.exports = {
  appInputsUnchanged,
  changedPaths,
  cleanupPreview,
  createBuildRequest,
  inspectBuild,
  inspectPublish,
  prepareArtifact,
  publish,
  reconcilePullRequest,
  retirePreview,
  reportPublishFailure,
  runLifecycle,
  sourceRequest,
  validRequest,
};
