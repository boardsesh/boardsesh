import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FULL_SHA = /^[0-9a-f]{40}$/;

function repositorySlug(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('GITHUB_REPOSITORY must be owner/name');
  }
  return value;
}

function selectedPullRequest(eventName, eventPayload) {
  if (eventName === 'workflow_dispatch') {
    const rawNumber = eventPayload?.inputs?.pr_number;
    if (typeof rawNumber !== 'string' || !/^[1-9]\d*$/.test(rawNumber)) {
      throw new Error('workflow_dispatch requires a positive numeric inputs.pr_number');
    }
    const number = Number(rawNumber);
    if (!Number.isSafeInteger(number)) throw new Error('PR number is outside the safe integer range');
    return { number, eventHeadSha: null, eventHeadRepo: null };
  }

  if (eventName === 'pull_request') {
    const pullRequest = eventPayload?.pull_request;
    const number = eventPayload?.number;
    const headSha = pullRequest?.head?.sha;
    const headRepo = pullRequest?.head?.repo?.full_name;
    if (!Number.isSafeInteger(number) || number < 1 || typeof headSha !== 'string' || !headRepo) {
      throw new Error('pull_request event is missing its selected PR identity');
    }
    return { number, eventHeadSha: headSha, eventHeadRepo: headRepo };
  }

  throw new Error(`unsupported branch-deploy event: ${String(eventName)}`);
}

/** Resolve a same-repository open PR to the immutable source commit the job must build. */
export async function resolveBranchDeploySource({
  eventName,
  eventPayload,
  repository: rawRepository,
  apiUrl = 'https://api.github.com',
  token,
  fetchImpl = fetch,
}) {
  const repository = repositorySlug(rawRepository);
  const selection = selectedPullRequest(eventName, eventPayload);
  const apiBase = new URL(apiUrl);
  if (apiBase.protocol !== 'https:') throw new Error('GitHub API URL must use HTTPS');
  const response = await fetchImpl(new URL(`/repos/${repository}/pulls/${selection.number}`, apiBase), {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`selected PR lookup failed with HTTP ${response.status}`);

  const pullRequest = await response.json();
  if (pullRequest.number !== selection.number) throw new Error('GitHub returned a different PR number');
  if (pullRequest.state !== 'open') throw new Error(`selected PR #${selection.number} is not open`);

  const baseRepository = pullRequest.base?.repo?.full_name;
  const headRepository = pullRequest.head?.repo?.full_name;
  const headSha = pullRequest.head?.sha;
  if (baseRepository?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('selected PR targets a different repository');
  }
  if (headRepository?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('branch previews only accept same-repository PR heads');
  }
  if (typeof headSha !== 'string' || !FULL_SHA.test(headSha)) {
    throw new Error('selected PR does not have a valid immutable head SHA');
  }

  if (selection.eventHeadSha !== null) {
    if (selection.eventHeadSha !== headSha) throw new Error('pull_request event head no longer matches GitHub');
    if (selection.eventHeadRepo?.toLowerCase() !== headRepository.toLowerCase()) {
      throw new Error('pull_request event repository does not match GitHub');
    }
  }

  return { number: selection.number, sourceSha: headSha };
}

async function runCli() {
  const eventPayload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const resolved = await resolveBranchDeploySource({
    eventName: process.env.GITHUB_EVENT_NAME,
    eventPayload,
    repository: process.env.GITHUB_REPOSITORY,
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    token: process.env.GH_TOKEN,
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `pr_number=${resolved.number}\nsource_sha=${resolved.sourceSha}\n`);
  console.log(`Resolved PR #${resolved.number} to immutable source SHA ${resolved.sourceSha}`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href
) {
  runCli().catch((error) => {
    console.error(`[branch-deploy-source] ${error instanceof Error ? error.message : 'lookup failed'}`);
    process.exitCode = 1;
  });
}
