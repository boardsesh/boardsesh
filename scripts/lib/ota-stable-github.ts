/// <reference types="node" />

/** Trusted artifacts only: main's deployment and the stable controller's own checkpoints. */
export const SOURCE_WORKFLOW = '.github/workflows/production-deploy.yml';
export const STABLE_WORKFLOW = '.github/workflows/mobile-ota-stable-release.yml';

export interface TrustedWorkflowRun {
  runId: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  command: 'prepare' | 'tick' | 'plan' | 'qualify' | 'abort' | null;
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
    const match = /^OTA stable (prepare|tick|plan|qualify|abort)$/.exec(String(run.display_title));
    if (match === null) throw new Error('Stable workflow run has no trusted controller command.');
    command = match[1] as TrustedWorkflowRun['command'];
  }
  return {
    runId: githubId(run.id, 'Workflow run id'),
    headSha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion as string | null,
    command,
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
  latestCheckpoint(excludeRunId: number): Promise<TrustedArtifact | null>;
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

  async function artifactFor(run: TrustedWorkflowRun, name: string): Promise<TrustedArtifact | null> {
    const matches: unknown[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = object(await api(`/actions/runs/${run.runId}/artifacts?per_page=100&page=${page}`), 'Artifacts');
      if (!Array.isArray(response.artifacts)) throw new Error('GitHub artifacts must be an array.');
      matches.push(...response.artifacts.filter((entry: unknown) => object(entry, 'Artifact').name === name));
      if (response.artifacts.length < 100) {
        if (matches.length > 1) throw new Error(`Run ${run.runId} has ambiguous artifacts named ${name}.`);
        return matches.length === 0 ? null : parseTrustedArtifact(matches[0], run, name, nowMs());
      }
    }
    throw new Error('Artifact search exceeded 100 pages.');
  }

  return {
    async latestSource() {
      for await (const input of runs(SOURCE_WORKFLOW)) {
        const run = parseTrustedRun(input, options.repository, SOURCE_WORKFLOW);
        if (run.status !== 'completed' || run.conclusion !== 'success') continue;
        const artifact = await artifactFor(run, 'mobile-ota-stage');
        if (artifact !== null) return artifact;
      }
      throw new Error('No successful main deployment has a staged OTA artifact.');
    },
    async latestCheckpoint(excludeRunId) {
      const currentRunId = BigInt(githubId(excludeRunId, 'Current checkpoint run id'));
      for await (const input of runs(STABLE_WORKFLOW)) {
        const listedRunId = BigInt(githubId(object(input, 'Workflow run').id, 'Workflow run id'));
        if (listedRunId === currentRunId) continue;
        const run = parseTrustedRun(input, options.repository, STABLE_WORKFLOW);
        if (run.command === 'plan') continue;
        if (listedRunId > currentRunId) {
          // Queued successors cannot write yet. A newer started/completed writer
          // means allocation order is not execution order: never load older state.
          if (['queued', 'pending', 'waiting', 'requested'].includes(run.status)) continue;
          throw new Error(
            `Newer stable write run ${run.runId} is ${run.status}; dispatch a new controller run before releasing.`,
          );
        }
        if (run.status !== 'completed')
          throw new Error(`Stable checkpoint run ${run.runId} is still ${run.status}; hold until it finishes.`);
        const artifact = await artifactFor(run, 'mobile-ota-stable-state');
        if (artifact === null)
          throw new Error(
            `Latest stable checkpoint ${run.runId} has no state artifact; recover that run before releasing.`,
          );
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
