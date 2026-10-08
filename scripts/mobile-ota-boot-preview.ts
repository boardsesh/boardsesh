/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { object, UPDATE_ID } from './lib/ota-publish-protocol.ts';

export const PREVIEW_WORKFLOW = '.github/workflows/mobile-ota-preview.yml';
export const PREVIEW_ARTIFACT = 'mobile-ota-preview-receipt';
export const PREVIEW_WAIT_MS = 25 * 60_000;

export interface PreviewProof {
  repository: string;
  headSha: string;
  pullRequest: number;
}
function positiveId(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input <= 0)
    throw new Error('Invalid GitHub provenance ID.');
  return input;
}

export function validatePreviewRun(input: unknown, proof: PreviewProof): Record<string, unknown> {
  const run = object(input, 'Preview run');
  if (
    run.path !== PREVIEW_WORKFLOW ||
    run.event !== 'pull_request' ||
    run.head_sha !== proof.headSha ||
    object(run.repository, 'run repository').full_name !== proof.repository ||
    object(run.head_repository, 'run head repository').full_name !== proof.repository ||
    !Array.isArray(run.pull_requests) ||
    !run.pull_requests.some((input) => {
      const pr = object(input, 'run pull request');
      return pr.number === proof.pullRequest && object(pr.head, 'run PR head').sha === proof.headSha;
    })
  ) {
    throw new Error('Preview run is not the trusted workflow for the pinned PR head.');
  }
  positiveId(run.id);
  return run;
}

export function validatePreviewArtifact(
  input: unknown,
  run: Record<string, unknown>,
  proof: PreviewProof,
  nowMs: number,
): number {
  const artifact = object(input, 'Preview artifact');
  const provenance = object(artifact.workflow_run, 'artifact workflow run');
  if (
    artifact.name !== PREVIEW_ARTIFACT ||
    artifact.expired !== false ||
    typeof artifact.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(artifact.expires_at)) ||
    Date.parse(artifact.expires_at) <= nowMs ||
    provenance.id !== run.id ||
    provenance.head_sha !== proof.headSha ||
    typeof artifact.size_in_bytes !== 'number' ||
    artifact.size_in_bytes <= 0 ||
    artifact.size_in_bytes > 1024 * 1024
  )
    throw new Error('Preview receipt is expired, oversized or belongs to another commit/run.');
  return positiveId(artifact.id);
}

export function validatePreviewReceipt(input: unknown, proof: PreviewProof, runId: number) {
  const receipt = object(input, 'Preview receipt');
  if (
    receipt.version !== 1 ||
    receipt.commitHash !== proof.headSha ||
    receipt.branch !== `pr-${proof.pullRequest}` ||
    receipt.previewRunId !== runId
  )
    throw new Error('Preview receipt does not attest the pinned PR head/run.');
  positiveId(receipt.deploymentId);
  const platforms = object(receipt.platforms, 'Preview platforms');
  for (const platform of ['ios', 'android']) {
    const fields = object(platforms[platform], `${platform} preview`);
    if (
      typeof fields.runtimeVersion !== 'string' ||
      !/^[0-9a-f]{40}$/.test(fields.runtimeVersion) ||
      typeof fields.bundleSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(fields.bundleSha256) ||
      typeof fields.updateId !== 'string' ||
      !UPDATE_ID.test(fields.updateId)
    )
      throw new Error(`Invalid ${platform} preview identity.`);
  }
  return receipt;
}

export function validatePreviewDeployment(
  input: unknown,
  statusesInput: unknown,
  proof: PreviewProof,
  deploymentId: number,
): void {
  const deployment = object(input, 'Preview deployment');
  if (
    deployment.id !== deploymentId ||
    deployment.sha !== proof.headSha ||
    deployment.ref !== proof.headSha ||
    deployment.environment !== 'pr-preview' ||
    deployment.production_environment !== false ||
    deployment.transient_environment !== true ||
    deployment.description !== `OTA preview pr-${proof.pullRequest}` ||
    !Array.isArray(statusesInput) ||
    object(statusesInput[0], 'Latest deployment status').state !== 'success'
  )
    throw new Error('Preview deployment does not prove successful publication of the pinned PR head.');
}

const READ_RECEIPT_ZIP = `import sys, zipfile, stat
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if len(entries) != 1 or entries[0].filename != 'receipt.json':
        raise ValueError('Preview artifact must contain exactly receipt.json')
    entry = entries[0]
    mode = entry.external_attr >> 16
    if entry.file_size > 256 * 1024 or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)):
        raise ValueError('Unsafe preview receipt ZIP entry')
    sys.stdout.buffer.write(archive.read(entry))
`;
export function readPreviewReceiptZip(bytes: Uint8Array): unknown {
  const scratch = mkdtempSync(join(tmpdir(), 'ota-preview-receipt-'));
  try {
    const archivePath = join(scratch, 'preview.zip');
    writeFileSync(archivePath, bytes);
    return JSON.parse(
      execFileSync('python3', ['-c', READ_RECEIPT_ZIP, archivePath], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ) as unknown;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function resolvePreviewReceipt(
  proof: PreviewProof,
  options: {
    token: string;
    fetchImpl?: typeof fetch;
    nowMs?: () => number;
    sleeper?: (durationMs: number) => Promise<unknown>;
    waitMs?: number;
  },
): Promise<Record<string, unknown>> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(proof.repository) || !/^[0-9a-f]{40}$/.test(proof.headSha))
    throw new Error('Invalid pinned preview source.');
  positiveId(proof.pullRequest);
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now;
  const finishBy = nowMs() + (options.waitMs ?? PREVIEW_WAIT_MS);
  const baseUrl = `https://api.github.com/repos/${proof.repository}`;
  const request = async (url: string, authenticated = true, binary = false): Promise<unknown> => {
    const cancellation = new AbortController();
    const deadline = setTimeout(
      () => cancellation.abort(new Error('Preview evidence HTTP deadline exceeded.')),
      Math.max(1, Math.min(30_000, finishBy - nowMs())),
    );
    try {
      const response = await fetchImpl(url, {
        signal: cancellation.signal,
        redirect: 'manual',
        headers: authenticated
          ? {
              Authorization: `Bearer ${options.token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            }
          : {},
      });
      if (binary && authenticated && response.status === 302) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Missing signed preview artifact URL.');
        const signed = new URL(location);
        if (signed.protocol !== 'https:' || signed.username || signed.password)
          throw new Error('Unsafe signed preview artifact URL.');
        // Never send the GitHub credential to artifact storage. The signed read has its own bounded body deadline.
        return await request(location, false, true);
      }
      if (!response.ok) throw new Error(`Preview evidence request returned HTTP ${response.status}.`);
      if (binary) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 1024 * 1024) throw new Error('Preview artifact exceeds 1 MiB.');
        return bytes;
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(deadline);
    }
  };
  const requirePinnedHead = async () => {
    const pr = object(await request(`${baseUrl}/pulls/${proof.pullRequest}`), 'Pull request');
    const head = object(pr.head, 'PR head');
    if (
      pr.state !== 'open' ||
      head.sha !== proof.headSha ||
      object(head.repo, 'PR head repository').full_name !== proof.repository
    )
      throw new Error('PR head moved, closed or belongs to another repository.');
  };
  while (nowMs() < finishBy) {
    await requirePinnedHead();
    const response = object(
      await request(
        `${baseUrl}/actions/workflows/mobile-ota-preview.yml/runs?event=pull_request&head_sha=${proof.headSha}&per_page=100`,
      ),
      'Preview runs',
    );
    if (!Array.isArray(response.workflow_runs)) throw new Error('Missing preview workflow runs.');
    const matchingRuns = response.workflow_runs
      .map((input) => validatePreviewRun(input, proof))
      .sort((left, right) => Number(right.id) - Number(left.id));
    const run = matchingRuns[0];
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success')
        throw new Error(
          `Pinned preview run ${String(run.id)} completed with ${String(run.conclusion)}; no boot proof can be made.`,
        );
      const artifacts = object(
        await request(`${baseUrl}/actions/runs/${String(run.id)}/artifacts?per_page=100`),
        'Preview artifacts',
      );
      if (!Array.isArray(artifacts.artifacts)) throw new Error('Missing preview artifact list.');
      const receipts = artifacts.artifacts.filter((input) => object(input, 'Artifact').name === PREVIEW_ARTIFACT);
      if (receipts.length !== 1)
        throw new Error(`Pinned preview run ${String(run.id)} has no unique receipt for both platforms.`);
      const artifactId = validatePreviewArtifact(receipts[0], run, proof, nowMs());
      const receipt = validatePreviewReceipt(
        readPreviewReceiptZip(
          (await request(`${baseUrl}/actions/artifacts/${artifactId}/zip`, true, true)) as Uint8Array,
        ),
        proof,
        Number(run.id),
      );
      validatePreviewDeployment(
        await request(`${baseUrl}/deployments/${String(receipt.deploymentId)}`),
        await request(`${baseUrl}/deployments/${String(receipt.deploymentId)}/statuses?per_page=1`),
        proof,
        Number(receipt.deploymentId),
      );
      await requirePinnedHead();
      return receipt;
    }
    await (options.sleeper ?? sleep)(Math.max(1, Math.min(15_000, finishBy - nowMs())));
  }
  throw new Error('Timed out after 25 minutes waiting for a successful preview receipt for the pinned PR head.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [headSha, prNumber, outPath] = process.argv.slice(2);
  if (!outPath || !process.env.GITHUB_REPOSITORY || !process.env.GH_TOKEN)
    throw new Error('Expected pinned SHA, PR number, output path and GitHub credentials.');
  const receipt = await resolvePreviewReceipt(
    { repository: process.env.GITHUB_REPOSITORY, headSha, pullRequest: Number(prNumber) },
    { token: process.env.GH_TOKEN },
  );
  writeFileSync(outPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx' });
  console.log(
    `Using frozen preview run ${String(receipt.previewRunId)}, deployment ${String(receipt.deploymentId)} for ${String(receipt.commitHash)}.`,
  );
}
