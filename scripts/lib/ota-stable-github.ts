/// <reference types="node" />

/** Trusted artifacts only: main's deployment and the stable controller's own checkpoints. */
export const SOURCE_WORKFLOW = '.github/workflows/production-deploy.yml';
export const STABLE_WORKFLOW = '.github/workflows/mobile-ota-stable-release.yml';
/** Hard ceiling for complete job listings; each caller also bounds its total API work. */
export const MAX_GITHUB_JOB_PAGES = 100;
/** Keep in sync with the workflow; unknown jobs cannot prove production ownership. */
export const STABLE_CONTROLLER_JOBS = [
  'resolve',
  'live-store-runtimes',
  'prepare',
  'qualify',
  'tick',
  'smokes',
  'boot',
  'notify',
];
/** GitHub expands this exact reusable query job when its caller executes. */
const LIVE_STORE_RUNTIME_JOB = 'live-store-runtimes / resolve';

export interface TrustedWorkflowRun {
  runId: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  command: 'prepare' | 'tick' | 'plan' | 'qualify' | 'abort' | 'start' | 'force-release' | null;
  runAttempt: number;
}

export interface TrustedArtifact {
  runId: number;
  headSha: string;
  artifactId: number;
}

function object(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error(`${label} must be an object.`);
  return input as Record<string, unknown>;
}

export function githubId(input: unknown, label: string): number {
  const identifier = typeof input === 'string' && /^[1-9][0-9]*$/.test(input) ? Number(input) : input;
  if (typeof identifier !== 'number' || !Number.isSafeInteger(identifier) || identifier < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return identifier;
}

export function parseTrustedRun(input: unknown, repository: string, workflow: string): TrustedWorkflowRun {
  const run = object(input, 'Workflow run');
  if (
    run.path !== workflow ||
    run.head_branch !== 'main' ||
    object(run.repository, 'Run repository').full_name !== repository ||
    object(run.head_repository, 'Run head_repository').full_name !== repository
  )
    throw new Error('Workflow run is not from the trusted workflow on repository main.');
  const allowedEvents = workflow === SOURCE_WORKFLOW ? ['push'] : ['schedule', 'workflow_dispatch'];
  if (!allowedEvents.includes(String(run.event))) throw new Error('Workflow run has an untrusted event.');
  if (typeof run.head_sha !== 'string' || !/^[0-9a-f]{40}$/.test(run.head_sha))
    throw new Error('Workflow run has an invalid head SHA.');
  if (typeof run.status !== 'string' || (run.conclusion !== null && typeof run.conclusion !== 'string')) {
    throw new Error('Workflow run has an invalid status or conclusion.');
  }
  let command: TrustedWorkflowRun['command'] = null;
  if (workflow === STABLE_WORKFLOW) {
    const match = /^OTA stable (prepare|tick|plan|qualify|abort|start|force-release)$/.exec(String(run.display_title));
    if (match === null) throw new Error('Stable workflow run has no trusted controller command.');
    command = match[1] as TrustedWorkflowRun['command'];
  }
  return {
    runId: githubId(run.id, 'Workflow run id'),
    headSha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion as string | null,
    command,
    runAttempt: githubId(run.run_attempt, 'Workflow run attempt'),
  };
}

export function parseTrustedArtifact(
  input: unknown,
  run: TrustedWorkflowRun,
  name: string,
  nowMs = Date.now(),
): TrustedArtifact {
  const artifact = object(input, 'Artifact');
  if (artifact.name !== name) throw new Error(`Expected artifact ${name}.`);
  if (
    artifact.expired !== false ||
    typeof artifact.expires_at !== 'string' ||
    !(Date.parse(artifact.expires_at) > nowMs)
  ) {
    throw new Error(`Artifact ${name} for run ${run.runId} is expired or has no valid expiry.`);
  }
  if (
    typeof artifact.size_in_bytes !== 'number' ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > 1_073_741_824
  ) {
    throw new Error(`Artifact ${name} has an invalid archive size.`);
  }
  const provenance = object(artifact.workflow_run, 'Artifact workflow_run');
  if (provenance.id !== run.runId || provenance.head_sha !== run.headSha || provenance.head_branch !== 'main') {
    throw new Error(`Artifact ${name} does not belong to trusted run ${run.runId}.`);
  }
  return { runId: run.runId, headSha: run.headSha, artifactId: githubId(artifact.id, 'Artifact id') };
}

export interface StableGithubClient {
  latestSource(): Promise<TrustedArtifact>;
  source(runId: number): Promise<TrustedArtifact>;
  /** External publishers may inspect the latest state only while holding mobile-ota-production. */
  latestCheckpoint(excludeRunId: number, productionLockHeld?: boolean): Promise<TrustedArtifact | null>;
  candidate(runId: number): Promise<TrustedArtifact>;
  downloadArtifact(artifactId: number): Promise<Uint8Array>;
}

export function createStableGithubClient(options: {
  repository: string;
  token: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}): StableGithubClient {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) throw new Error('Invalid GitHub repository.');
  if (options.token.trim() === '') throw new Error('GH_TOKEN or GITHUB_TOKEN is required.');
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now;
  const apiBase = `https://api.github.com/repos/${options.repository}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${options.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };

  async function bounded<T>(action: (signal: AbortSignal) => Promise<T>, milliseconds = 30_000): Promise<T> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('GitHub artifact request timed out.')), milliseconds);
    try {
      return await action(controller.signal);
    } catch (error) {
      controller.signal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }

  async function api(path: string): Promise<unknown> {
    return bounded(async (signal) => {
      const response = await fetchImpl(`${apiBase}${path}`, { headers, signal, redirect: 'error' });
      if (!response.ok) throw new Error(`GitHub API ${path} failed (${response.status}).`);
      return response.json() as Promise<unknown>;
    });
  }

  async function* runs(workflow: string): AsyncGenerator<unknown> {
    for (let page = 1; page <= 100; page++) {
      const eventFilter = workflow === SOURCE_WORKFLOW ? '&event=push' : '';
      const response = object(
        await api(
          `/actions/workflows/${workflow.split('/').at(-1)}/runs?branch=main&per_page=100&page=${page}${eventFilter}`,
        ),
        'Workflow runs',
      );
      if (!Array.isArray(response.workflow_runs)) throw new Error('GitHub workflow_runs must be an array.');
      for (const run of response.workflow_runs) yield run;
      if (response.workflow_runs.length < 100) return;
    }
    throw new Error('Workflow run search exceeded 100 pages; refusing an incomplete history.');
  }

  const artifactsByRun = new Map<number, unknown[]>();
  async function artifactFor(run: TrustedWorkflowRun, name: string): Promise<TrustedArtifact | null> {
    const select = (artifacts: unknown[]) => {
      const matches = artifacts.filter((entry) => object(entry, 'Artifact').name === name);
      if (matches.length > 1) throw new Error(`Run ${run.runId} has ambiguous artifacts named ${name}.`);
      return matches.length === 0 ? null : parseTrustedArtifact(matches[0], run, name, nowMs());
    };
    const cached = artifactsByRun.get(run.runId);
    if (cached) return select(cached);
    const matches: unknown[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = object(await api(`/actions/runs/${run.runId}/artifacts?per_page=100&page=${page}`), 'Artifacts');
      if (!Array.isArray(response.artifacts)) throw new Error('GitHub artifacts must be an array.');
      matches.push(...response.artifacts);
      if (response.artifacts.length < 100) {
        artifactsByRun.set(run.runId, matches);
        return select(matches);
      }
    }
    throw new Error('Artifact search exceeded 100 pages.');
  }

  async function provedNoWrites(run: TrustedWorkflowRun): Promise<boolean> {
    if (
      run.runAttempt !== 1 ||
      !['failure', 'cancelled', 'timed_out', 'startup_failure'].includes(run.conclusion ?? '')
    )
      return false;
    const jobs: unknown[] = [];
    let total: number | null = null;
    for (let page = 1; page <= MAX_GITHUB_JOB_PAGES; page++) {
      const response = object(
        await api(`/actions/runs/${run.runId}/attempts/1/jobs?per_page=100&page=${page}`),
        'Attempt jobs',
      );
      if (
        !Array.isArray(response.jobs) ||
        !Number.isSafeInteger(response.total_count) ||
        Number(response.total_count) < 0
      )
        throw new Error('GitHub attempt jobs have incomplete pagination metadata.');
      if (total !== null && total !== response.total_count) throw new Error('GitHub attempt job count changed.');
      total = Number(response.total_count);
      jobs.push(...response.jobs);
      if (jobs.length > total) throw new Error('GitHub attempt jobs exceed the reported total.');
      if (jobs.length === total) break;
      if (response.jobs.length !== 100 || page === MAX_GITHUB_JOB_PAGES)
        throw new Error('GitHub attempt jobs are incomplete.');
    }
    if (jobs.length === 0) return run.conclusion === 'startup_failure';
    const controllers: Record<string, string> = {
      prepare: 'Freeze the exact archived bytes',
      qualify: 'Record blocking QA verdict',
      tick: 'Judge and apply at most one timed step',
    };
    const knownSteps = new Set([
      'Set up job',
      'Complete job',
      'Refuse any ref but main',
      'Resolve command',
      'Restore trusted checkpoint and source deployment',
      'Restore trusted checkpoint and its exact candidate',
      'Retain preparation checkpoint',
      'Retain frozen candidate',
      'Retain final checkpoint even when QA fails',
      'Check qualified candidate without waiting for cron',
      'Collect durable upload leases',
      'Retain checkpoint and upload leases',
      'Resolve exact publicly available store runtimes',
      'Download public store runtimes',
      'Deliver pending deployment events',
      'Retain delivery receipts even when Discord fails',
      'Surface notification delivery failure',
    ]);
    const requiredJobs = ['resolve', 'prepare', 'qualify', 'tick'];
    const optionalSkippedJobs = ['smokes', 'boot', 'live-store-runtimes'];
    const readOnlyJobs = ['notify', LIVE_STORE_RUNTIME_JOB];
    const jobNames = new Set<string>();
    const jobIds = new Set<number>();
    for (const input of jobs) {
      const job = object(input, 'Attempt job');
      const jobId = githubId(job.id, 'Attempt job id');
      if (jobIds.has(jobId)) return false;
      jobIds.add(jobId);
      if (
        job.run_id !== run.runId ||
        job.run_attempt !== 1 ||
        job.head_sha !== run.headSha ||
        job.run_url !== `${apiBase}/actions/runs/${run.runId}` ||
        job.status !== 'completed'
      )
        return false;
      if (
        typeof job.name !== 'string' ||
        (!requiredJobs.includes(job.name) &&
          !optionalSkippedJobs.includes(job.name) &&
          !readOnlyJobs.includes(job.name)) ||
        jobNames.has(job.name)
      )
        return false;
      jobNames.add(job.name);
      if (job.conclusion === 'skipped') {
        if (job.steps !== undefined && (!Array.isArray(job.steps) || job.steps.length !== 0)) return false;
        continue;
      }
      if (
        optionalSkippedJobs.includes(job.name) ||
        !['success', 'failure', 'cancelled', 'timed_out'].includes(String(job.conclusion)) ||
        !Array.isArray(job.steps)
      )
        return false;
      const expectedController = controllers[job.name];
      let controllerSkipped = expectedController === undefined;
      const stepNumbers = new Set<number>();
      for (const inputStep of job.steps) {
        const step = object(inputStep, 'Attempt job step');
        const stepNumber = githubId(step.number, 'Attempt job step number');
        if (stepNumbers.has(stepNumber) || step.status !== 'completed' || typeof step.name !== 'string') return false;
        stepNumbers.add(stepNumber);
        if (step.name === expectedController) {
          if (controllerSkipped || step.conclusion !== 'skipped') return false;
          controllerSkipped = true;
        } else if (
          !knownSteps.has(step.name) &&
          !/^(?:Post )?(?:Run )?actions\/(?:checkout|setup-node|download-artifact|upload-artifact)@[0-9a-f]{40}$/.test(
            step.name,
          )
        )
          return false;
        if (!['success', 'failure', 'cancelled', 'skipped', 'timed_out'].includes(String(step.conclusion)))
          return false;
      }
      if (!controllerSkipped) return false;
    }
    // GitHub may omit skipped reusable-workflow caller placeholders. Every
    // direct controller job must still supply positive no-write evidence.
    return requiredJobs.every((jobName) => jobNames.has(jobName));
  }

  return {
    async source(runId) {
      const identifier = githubId(runId, 'Source run id');
      const run = parseTrustedRun(await api(`/actions/runs/${identifier}`), options.repository, SOURCE_WORKFLOW);
      if (run.runId !== identifier || run.status !== 'completed' || run.conclusion !== 'success')
        throw new Error('Source must belong to a successful completed main push deployment.');
      const artifact = await artifactFor(run, 'mobile-ota-stage');
      if (artifact === null) throw new Error(`Source run ${identifier} has no staged OTA artifact.`);
      return artifact;
    },
    async latestSource() {
      for await (const input of runs(SOURCE_WORKFLOW)) {
        const run = parseTrustedRun(input, options.repository, SOURCE_WORKFLOW);
        if (run.status !== 'completed' || run.conclusion !== 'success') continue;
        const artifact = await artifactFor(run, 'mobile-ota-stage');
        if (artifact !== null) return artifact;
      }
      throw new Error('No successful main deployment has a staged OTA artifact.');
    },
    async latestCheckpoint(excludeRunId, productionLockHeld = false) {
      const currentRunId = BigInt(githubId(excludeRunId, 'Current checkpoint run id'));
      for await (const input of runs(STABLE_WORKFLOW)) {
        const listedRunId = BigInt(githubId(object(input, 'Workflow run').id, 'Workflow run id'));
        if (listedRunId === currentRunId) continue;
        const run = parseTrustedRun(input, options.repository, STABLE_WORKFLOW);
        if (run.command === 'plan') continue;
        if (productionLockHeld && run.status !== 'completed' && run.runAttempt !== 1)
          throw new Error('An unfinished repeated controller attempt needs explicit checkpoint recovery.');
        if (productionLockHeld && ['queued', 'pending', 'waiting', 'requested'].includes(run.status)) continue;
        let finishedLockedWriter = false;
        if (productionLockHeld && run.status === 'in_progress') {
          // Preparation only publishes to its candidate branch, never production.
          // The production lock prevents a queued tick from beginning its job.
          if (run.command === 'prepare') continue;
          const jobs: unknown[] = [];
          let total: number | null = null;
          for (let page = 1; page <= MAX_GITHUB_JOB_PAGES; page++) {
            const response = object(
              await api(`/actions/runs/${run.runId}/jobs?per_page=100&page=${page}`),
              'Locked writer jobs',
            );
            if (
              !Array.isArray(response.jobs) ||
              !Number.isSafeInteger(response.total_count) ||
              Number(response.total_count) < 0
            )
              throw new Error('Locked writer job pagination is incomplete.');
            if (total !== null && total !== response.total_count) throw new Error('Locked writer job count changed.');
            total = Number(response.total_count);
            jobs.push(...response.jobs);
            if (jobs.length === total) break;
            if (jobs.length > total || response.jobs.length !== 100 || page === MAX_GITHUB_JOB_PAGES)
              throw new Error('Locked writer job pagination is incomplete.');
          }
          const jobIds = new Set<number>();
          const jobNames = new Set<string>();
          const checkedJobs = jobs.map((job) => {
            const checked = object(job, 'Locked writer job');
            const id = githubId(checked.id, 'Locked writer job id');
            if (
              checked.run_id !== run.runId ||
              checked.head_sha !== run.headSha ||
              checked.run_attempt !== 1 ||
              checked.run_url !== `${apiBase}/actions/runs/${run.runId}` ||
              (!STABLE_CONTROLLER_JOBS.includes(String(checked.name)) && checked.name !== LIVE_STORE_RUNTIME_JOB) ||
              (checked.name === 'live-store-runtimes' &&
                (checked.status !== 'completed' ||
                  checked.conclusion !== 'skipped' ||
                  (checked.steps !== undefined && (!Array.isArray(checked.steps) || checked.steps.length !== 0)))) ||
              jobIds.has(id) ||
              jobNames.has(String(checked.name))
            )
              throw new Error('Locked controller job identity or uniqueness cannot be proven.');
            jobIds.add(id);
            jobNames.add(String(checked.name));
            return checked;
          });
          const writers = checkedJobs.filter((job) => job.name === 'tick');
          if (
            writers.length !== 1 ||
            writers[0].run_id !== run.runId ||
            writers[0].head_sha !== run.headSha ||
            writers[0].run_attempt !== run.runAttempt
          )
            throw new Error('Cannot prove which controller job is waiting for the production lock.');
          const writer = writers[0];
          if (['queued', 'pending', 'waiting', 'requested'].includes(String(writer.status))) {
            if (
              !Array.isArray(writer.steps) ||
              writer.steps.some((step) =>
                ['completed', 'in_progress'].includes(String(object(step, 'Waiting controller step').status)),
              )
            )
              throw new Error('Waiting controller job already reports executed steps.');
            continue;
          }
          finishedLockedWriter = writer.status === 'completed';
        }
        if (!productionLockHeld && listedRunId > currentRunId) {
          // Queued successors cannot write yet. A newer started/completed writer
          // means allocation order is not execution order: never load older state.
          if (['queued', 'pending', 'waiting', 'requested'].includes(run.status)) continue;
          throw new Error(
            `Newer stable write run ${run.runId} is ${run.status}; dispatch a new controller run before releasing.`,
          );
        }
        if (run.status !== 'completed' && !finishedLockedWriter)
          throw new Error(`Stable checkpoint run ${run.runId} is still ${run.status}; hold until it finishes.`);
        // Notification jobs persist delivered IDs separately. If delivery never
        // starts, the original operation checkpoint still owns recovery.
        const artifact =
          (await artifactFor(run, 'mobile-ota-stable-notified-state')) ??
          (await artifactFor(run, 'mobile-ota-stable-state'));
        if (artifact === null) {
          if (await provedNoWrites(run)) {
            console.error(
              `Skipping stable run ${run.runId}: complete first-attempt evidence proves no controller writes.`,
            );
            continue;
          }
          throw new Error(
            `Latest stable checkpoint ${run.runId} has no state artifact; recover that run before releasing.`,
          );
        }
        return artifact;
      }
      return null;
    },
    async candidate(runId) {
      const run = parseTrustedRun(
        await api(`/actions/runs/${githubId(runId, 'Candidate run id')}`),
        options.repository,
        STABLE_WORKFLOW,
      );
      if (
        run.runId !== runId ||
        run.command !== 'prepare' ||
        run.status !== 'completed' ||
        run.conclusion !== 'success'
      ) {
        throw new Error('Candidate must belong to a successful completed prepare run.');
      }
      const artifact = await artifactFor(run, 'mobile-ota-stable-candidate');
      if (artifact === null) throw new Error(`Prepare run ${runId} has no candidate artifact.`);
      return artifact;
    },
    async downloadArtifact(artifactId) {
      return bounded(async (signal) => {
        const response = await fetchImpl(`${apiBase}/actions/artifacts/${githubId(artifactId, 'Artifact id')}/zip`, {
          headers,
          signal,
          redirect: 'manual',
        });
        let archive = response;
        if (response.status === 302) {
          const location = response.headers.get('location');
          if (location === null) throw new Error('GitHub artifact redirect has no location.');
          const destination = new URL(location);
          if (destination.protocol !== 'https:' || destination.username !== '' || destination.password !== '')
            throw new Error('Unsafe GitHub artifact redirect.');
          // Signed blob links need no token. Never forward GitHub credentials to storage.
          archive = await fetchImpl(destination, { signal, redirect: 'error' });
        }
        if (!archive.ok) throw new Error(`Artifact download failed (${archive.status}).`);
        const bytes = new Uint8Array(await archive.arrayBuffer());
        if (bytes.length < 1 || bytes.length > 1_073_741_824) throw new Error('Artifact download has an invalid size.');
        return bytes;
      }, 120_000);
    },
  };
}
