/// <reference types="node" />

/**
 * Picks the Metro transform store an OTA publish may download, or none.
 *
 *   vp exec tsx scripts/ci/metro-cache-select.ts
 *
 * Env: GITHUB_REPOSITORY, GITHUB_API_URL, GH_TOKEN (actions: read),
 * METRO_STORE_ARTIFACT (the expected artifact name, which carries the cache
 * key), METRO_CACHE_MAX_BYTES (default 1 GiB), GITHUB_RUN_ID, GITHUB_OUTPUT.
 * Writes `run_id` and `artifact_id` to GITHUB_OUTPUT when it finds one.
 *
 * Only the publish job of a trusted run uploads a `metro-ota-store-*` artifact
 * (see docs/mobile-ota-updates.md, "Metro transform cache"), so this accepts an
 * artifact only when the run that made it is one of those runs:
 *
 * - `.github/workflows/mobile-ota-production.yml` on main or release/next, or
 *   `.github/workflows/production-deploy.yml` on main (main's staging publish
 *   runs inside it as a workflow_call, so that is the run's path);
 * - triggered by push or workflow_dispatch, from this repository, not a fork;
 * - completed with conclusion success;
 * - the artifact is unexpired, non-empty, within the size budget, and named
 *   for exactly this cache key.
 *
 * The newest artifact that passes wins. None of this is the last line of
 * defence: the publish job still checks every tar member and the HMAC seal.
 * Any error here means "no store", never a failed publish.
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
/** Run lookups are one API call each; past this many candidates, build cold. */
export const MAX_CANDIDATES = 20;

const TRUSTED_PRODUCERS: ReadonlyArray<{ path: string; branches: ReadonlySet<string> }> = [
  { path: '.github/workflows/mobile-ota-production.yml', branches: new Set(['main', 'release/next']) },
  { path: '.github/workflows/production-deploy.yml', branches: new Set(['main']) },
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
  repository?: { id?: number | null } | null;
  head_repository?: { id?: number | null } | null;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

export function judgeArtifact(
  artifact: ArtifactRecord,
  options: { expectedName: string; maxBytes: number; currentRunId?: number },
): Verdict {
  if (artifact.name !== options.expectedName) return { ok: false, reason: 'named for another cache key' };
  if (artifact.expired) return { ok: false, reason: 'expired' };
  if (!(artifact.size_in_bytes > 0)) return { ok: false, reason: 'empty' };
  if (artifact.size_in_bytes > options.maxBytes) return { ok: false, reason: 'over the size budget' };
  const runId = artifact.workflow_run?.id;
  if (typeof runId !== 'number') return { ok: false, reason: 'no producing run' };
  if (runId === options.currentRunId) return { ok: false, reason: 'made by this run' };
  return { ok: true };
}

export function judgeRun(run: RunRecord, artifact: ArtifactRecord): Verdict {
  if (run.id !== artifact.workflow_run?.id) return { ok: false, reason: 'run does not match the artifact' };
  if (run.status !== 'completed' || run.conclusion !== 'success') return { ok: false, reason: 'run did not succeed' };
  if (!run.event || !TRUSTED_EVENTS.has(run.event)) return { ok: false, reason: `run event ${run.event}` };
  const repositoryId = run.repository?.id;
  if (typeof repositoryId !== 'number' || run.head_repository?.id !== repositoryId) {
    return { ok: false, reason: 'run came from another repository' };
  }
  const producer = TRUSTED_PRODUCERS.find((candidate) => candidate.path === run.path);
  if (!producer) return { ok: false, reason: `run of ${run.path}` };
  if (!run.head_branch || !producer.branches.has(run.head_branch)) {
    return { ok: false, reason: `run on ${run.head_branch}` };
  }
  if (artifact.workflow_run?.head_branch !== run.head_branch) {
    return { ok: false, reason: 'artifact branch does not match its run' };
  }
  return { ok: true };
}

/** Newest first; artifacts without a timestamp sort last. */
export function newestFirst(artifacts: ArtifactRecord[]): ArtifactRecord[] {
  const time = (artifact: ArtifactRecord) => Date.parse(artifact.created_at ?? '') || 0;
  return [...artifacts].sort((left, right) => time(right) - time(left));
}

export async function selectStore(
  artifacts: ArtifactRecord[],
  getRun: (runId: number) => Promise<RunRecord>,
  options: { expectedName: string; maxBytes: number; currentRunId?: number },
  log: (line: string) => void = () => {},
): Promise<{ artifact: ArtifactRecord; run: RunRecord } | null> {
  const candidates = newestFirst(artifacts).filter((artifact) => {
    const verdict = judgeArtifact(artifact, options);
    if (!verdict.ok) log(`skip artifact ${artifact.id}: ${verdict.reason}`);
    return verdict.ok;
  });
  for (const artifact of candidates.slice(0, MAX_CANDIDATES)) {
    const runId = artifact.workflow_run?.id as number;
    const run = await getRun(runId);
    const verdict = judgeRun(run, artifact);
    if (verdict.ok) return { artifact, run };
    log(`skip artifact ${artifact.id} from run ${runId}: ${verdict.reason}`);
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
  const listing = (await getJson(
    `${apiUrl}/repos/${repository}/actions/artifacts?name=${encodeURIComponent(expectedName)}&per_page=100`,
    token,
  )) as { artifacts?: ArtifactRecord[] };
  const chosen = await selectStore(
    listing.artifacts ?? [],
    async (runId) => (await getJson(`${apiUrl}/repos/${repository}/actions/runs/${runId}`, token)) as RunRecord,
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
