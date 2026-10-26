/// <reference types="node" />

/**
 * Picks the Metro transform store an OTA publish may download, or none.
 *
 *   vp exec tsx scripts/ci/metro-cache-select.ts
 *
 * Env: GITHUB_REPOSITORY, GITHUB_API_URL, GH_TOKEN (actions: read),
 * METRO_STORE_ARTIFACT (the expected artifact name, which carries the cache
 * key), METRO_CACHE_MAX_BYTES (default 1 GiB), GITHUB_RUN_ID, GITHUB_OUTPUT.
 * Writes `run_id` and `artifact_id` to GITHUB_OUTPUT when it finds one; the
 * workflow downloads by that id, never by name.
 *
 * Only the publish job of a trusted run uploads a `metro-ota-store-*` artifact
 * (see docs/mobile-ota-updates.md, "Metro transform cache"). So this starts
 * from the runs, not the artifacts: it lists recent successful runs of the
 * trusted workflows, newest first, and asks each one for an artifact with the
 * expected name. Artifacts uploaded anywhere else under the same name are
 * never listed. A run qualifies when it is:
 *
 * - `.github/workflows/mobile-ota-production.yml` on main or release/next, or
 *   `.github/workflows/production-deploy.yml` on main (main's staging publish
 *   runs inside it as a workflow_call, so that is the run's path);
 * - triggered by push or workflow_dispatch, from this repository, not a fork;
 * - completed with conclusion success, and not this run.
 *
 * Its artifact must be unexpired, non-empty, within the size budget, and named
 * for exactly this cache key. The newest qualifying run with such an artifact
 * wins. None of this is the last line of defence: the publish job still checks
 * the unpacked size, every tar member and the HMAC seal. Any error here means
 * "no store", never a failed publish.
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
/**
 * Runs asked for an artifact, one API call each. Most production-deploy runs
 * stage no OTA (no mobile change), so this looks back further than the last
 * few runs.
 */
export const MAX_RUN_LOOKUPS = 40;

export interface TrustedSource {
  workflowFile: string;
  path: string;
  branch: string;
}

export const TRUSTED_SOURCES: readonly TrustedSource[] = [
  {
    workflowFile: 'mobile-ota-production.yml',
    path: '.github/workflows/mobile-ota-production.yml',
    branch: 'main',
  },
  {
    workflowFile: 'mobile-ota-production.yml',
    path: '.github/workflows/mobile-ota-production.yml',
    branch: 'release/next',
  },
  { workflowFile: 'production-deploy.yml', path: '.github/workflows/production-deploy.yml', branch: 'main' },
];
const TRUSTED_EVENTS: ReadonlySet<string> = new Set(['push', 'workflow_dispatch']);

export interface ArtifactRecord {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  created_at: string | null;
  workflow_run?: { id?: number | null; head_branch?: string | null } | null;
}

export interface RunRecord {
  id: number;
  path?: string | null;
  event?: string | null;
  status?: string | null;
  conclusion?: string | null;
  head_branch?: string | null;
  created_at?: string | null;
  repository?: { id?: number | null } | null;
  head_repository?: { id?: number | null } | null;
}

export interface SelectOptions {
  expectedName: string;
  maxBytes: number;
  currentRunId?: number;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

export function judgeRun(run: RunRecord, currentRunId?: number): Verdict {
  if (run.id === currentRunId) return { ok: false, reason: 'this run' };
  if (run.status !== 'completed' || run.conclusion !== 'success') return { ok: false, reason: 'did not succeed' };
  if (!run.event || !TRUSTED_EVENTS.has(run.event)) return { ok: false, reason: `event ${run.event}` };
  const repositoryId = run.repository?.id;
  if (typeof repositoryId !== 'number' || run.head_repository?.id !== repositoryId) {
    return { ok: false, reason: 'from another repository' };
  }
  const trusted = TRUSTED_SOURCES.some((source) => source.path === run.path && source.branch === run.head_branch);
  if (!trusted) return { ok: false, reason: `${run.path} on ${run.head_branch}` };
  return { ok: true };
}

export function judgeArtifact(artifact: ArtifactRecord, run: RunRecord, options: SelectOptions): Verdict {
  if (artifact.name !== options.expectedName) return { ok: false, reason: 'named for another cache key' };
  if (artifact.expired) return { ok: false, reason: 'expired' };
  if (!(artifact.size_in_bytes > 0)) return { ok: false, reason: 'empty' };
  if (artifact.size_in_bytes > options.maxBytes) return { ok: false, reason: 'over the size budget' };
  if (artifact.workflow_run?.id !== run.id) return { ok: false, reason: 'not made by this run' };
  if (artifact.workflow_run?.head_branch !== run.head_branch) return { ok: false, reason: 'branch disagrees' };
  return { ok: true };
}

const timeOf = (value: string | null | undefined) => Date.parse(value ?? '') || 0;

export async function selectStore(
  listRuns: (source: TrustedSource) => Promise<RunRecord[]>,
  listArtifacts: (runId: number) => Promise<ArtifactRecord[]>,
  options: SelectOptions,
  log: (line: string) => void = () => {},
): Promise<{ artifact: ArtifactRecord; run: RunRecord } | null> {
  const runsById = new Map<number, RunRecord>();
  for (const source of TRUSTED_SOURCES) {
    for (const run of await listRuns(source)) {
      const verdict = judgeRun(run, options.currentRunId);
      if (verdict.ok) runsById.set(run.id, run);
      else log(`skip run ${run.id}: ${verdict.reason}`);
    }
  }
  const runs = [...runsById.values()]
    .sort((left, right) => timeOf(right.created_at) - timeOf(left.created_at))
    .slice(0, MAX_RUN_LOOKUPS);
  for (const run of runs) {
    const artifacts = (await listArtifacts(run.id)).sort(
      (left, right) => timeOf(right.created_at) - timeOf(left.created_at),
    );
    for (const artifact of artifacts) {
      const verdict = judgeArtifact(artifact, run, options);
      if (verdict.ok) return { artifact, run };
      log(`skip artifact ${artifact.id} from run ${run.id}: ${verdict.reason}`);
    }
  }
  return null;
}

async function getJson(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return response.json();
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GH_TOKEN;
  const expectedName = env.METRO_STORE_ARTIFACT;
  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com';
  const maxBytes = Number(env.METRO_CACHE_MAX_BYTES ?? DEFAULT_MAX_BYTES);
  const currentRunId = env.GITHUB_RUN_ID ? Number(env.GITHUB_RUN_ID) : undefined;
  if (!repository || !token || !expectedName?.startsWith('metro-ota-store-') || !(maxBytes > 0)) {
    console.log('Metro store lookup is not configured; building cold.');
    return;
  }
  const base = `${apiUrl}/repos/${repository}/actions`;
  const chosen = await selectStore(
    async (source) => {
      const query = `branch=${encodeURIComponent(source.branch)}&status=success&exclude_pull_requests=true&per_page=${MAX_RUN_LOOKUPS}`;
      const listing = (await getJson(`${base}/workflows/${source.workflowFile}/runs?${query}`, token)) as {
        workflow_runs?: RunRecord[];
      };
      return listing.workflow_runs ?? [];
    },
    async (runId) => {
      const listing = (await getJson(
        `${base}/runs/${runId}/artifacts?name=${encodeURIComponent(expectedName)}&per_page=100`,
        token,
      )) as { artifacts?: ArtifactRecord[] };
      return listing.artifacts ?? [];
    },
    { expectedName, maxBytes, currentRunId },
    (line) => console.log(line),
  );
  if (!chosen) {
    console.log(`No trusted ${expectedName} artifact; building cold.`);
    return;
  }
  console.log(
    `Using artifact ${chosen.artifact.id} (${chosen.artifact.size_in_bytes} bytes) from run ${chosen.run.id} (${chosen.run.path} on ${chosen.run.head_branch}).`,
  );
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `run_id=${chosen.run.id}\nartifact_id=${chosen.artifact.id}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // A lookup failure only costs a cold export. Keep the message generic.
    console.log(
      `::warning::Metro store lookup failed (${error instanceof Error ? error.message : 'unknown'}); building cold.`,
    );
    process.exitCode = 0;
  });
}
