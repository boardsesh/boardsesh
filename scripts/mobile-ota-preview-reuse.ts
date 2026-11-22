/// <reference types="node" />

// Read-only evidence check. A backend-only push may retain a preview only when
// its complete receipt and both public device manifests still prove what ships.
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasNativeAppAffectingChanges } from './lib/app-build-inputs.mjs';
import { OTA_APP_ID, readServedHead, sha256HexToBase64Url } from './lib/ota-boot-check.ts';
import { classifyServedManifest, object, requestManifest } from './lib/ota-publish-protocol.ts';
import {
  PREVIEW_ARTIFACT,
  readPreviewReceiptZip,
  validatePreviewArtifact,
  validatePreviewDeployment,
  validatePreviewReceipt,
  validatePreviewRun,
} from './mobile-ota-boot-preview.ts';

interface ReuseOptions {
  candidate: unknown;
  repository: string;
  headSha: string;
  mainSha: string;
  sourceBaseSha: string;
  sourceBaseRef: string;
  pullRequest: number;
  token: string;
  manifestUrl: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  readReceiptZip?: (bytes: Uint8Array) => unknown;
}

interface ReuseDecision {
  reuse: boolean;
  reason: string;
  servedSha?: string;
}

const SHA = /^[0-9a-f]{40}$/;
const MAX_BODY_BYTES = 1024 * 1024;

async function boundedBody(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Preview evidence has no body.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('Preview evidence exceeds 1 MiB.');
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks, length);
}

/** Uncertainty means a normal rebuild, never an unproven skip. */
export async function checkPreviewReuse(options: ReuseOptions): Promise<ReuseDecision> {
  try {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(options.repository) ||
      ![options.headSha, options.mainSha, options.sourceBaseSha].every((sha) => SHA.test(sha)) ||
      !Number.isSafeInteger(options.pullRequest) ||
      options.pullRequest <= 0 ||
      !options.token ||
      !options.sourceBaseRef ||
      new URL(options.manifestUrl).protocol !== 'https:'
    )
      throw new Error('Missing pinned preview context.');
    const candidate = object(options.candidate, 'Reuse candidate');
    const deployment = object(candidate.deployment, 'Preview deployment');
    const payload = object(deployment.payload, 'Preview payload');
    const bases = object(payload.otaPreviewBases, 'Preview bases');
    const previousSha = String(deployment.sha);
    const deploymentId = Number(deployment.id);
    const runId = Number(payload.otaPreviewRunId);
    if (
      !SHA.test(previousSha) ||
      !Number.isSafeInteger(deploymentId) ||
      deploymentId <= 0 ||
      !Number.isSafeInteger(runId) ||
      runId <= 0 ||
      candidate.status !== 'success' ||
      bases.version !== 2 ||
      bases.mainSha !== options.mainSha ||
      bases.sourceBaseSha !== options.sourceBaseSha ||
      bases.sourceBaseRef !== options.sourceBaseRef ||
      deployment.task !== `ota-preview-pr-${options.pullRequest}`
    )
      throw new Error('Previous publication has no matching successful receipt context.');
    const proof = { repository: options.repository, headSha: previousSha, pullRequest: options.pullRequest };
    validatePreviewDeployment(deployment, [{ state: candidate.status }], proof, deploymentId);
    const fetchImpl = options.fetchImpl ?? fetch;
    const apiBase = `https://api.github.com/repos/${options.repository}`;
    const request = async (path: string, binary = false): Promise<unknown> => {
      const response = await fetchImpl(`${apiBase}${path}`, {
        signal: AbortSignal.timeout(10000),
        redirect: 'manual',
        headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/vnd.github+json' },
      });
      if (binary) {
        const signedUrl = new URL(response.headers.get('location') ?? '');
        if (response.status !== 302 || signedUrl.protocol !== 'https:' || signedUrl.username || signedUrl.password)
          throw new Error('Invalid signed preview artifact location.');
        const download = await fetchImpl(signedUrl, { signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!download.ok) throw new Error(`Preview receipt download returned ${download.status}.`);
        return boundedBody(download);
      }
      if (!response.ok) throw new Error(`Preview evidence returned HTTP ${response.status}.`);
      return JSON.parse(new TextDecoder().decode(await boundedBody(response))) as unknown;
    };
    const comparison = object(await request(`/compare/${previousSha}...${options.headSha}?per_page=1`), 'Comparison');
    if (
      !['ahead', 'identical'].includes(String(comparison.status)) ||
      !Array.isArray(comparison.files) ||
      comparison.files.length >= 300
    )
      throw new Error('App input comparison is incomplete or diverged.');
    const paths = comparison.files.flatMap((input) => {
      const file = object(input, 'Compared file');
      if (typeof file.filename !== 'string') throw new Error('Compared filename is unreadable.');
      return [file.filename, ...(typeof file.previous_filename === 'string' ? [file.previous_filename] : [])];
    });
    if (hasNativeAppAffectingChanges(paths)) return { reuse: false, reason: 'Native app inputs changed.' };
    const run = validatePreviewRun(await request(`/actions/runs/${runId}`), proof);
    if (run.id !== runId || run.event !== 'pull_request' || run.status !== 'completed' || run.conclusion !== 'success')
      throw new Error('Previous automatic preview run did not finish successfully.');
    const artifactList = object(await request(`/actions/runs/${runId}/artifacts?per_page=100`), 'Artifacts');
    if (
      !Array.isArray(artifactList.artifacts) ||
      typeof artifactList.total_count !== 'number' ||
      artifactList.total_count !== artifactList.artifacts.length
    )
      throw new Error('Preview artifact list is incomplete.');
    const artifacts = artifactList.artifacts.filter((input) => object(input, 'Artifact').name === PREVIEW_ARTIFACT);
    if (artifacts.length !== 1) throw new Error('No unique retained preview receipt.');
    const artifactId = validatePreviewArtifact(artifacts[0], run, proof, (options.nowMs ?? Date.now)());
    const bytes = (await request(`/actions/artifacts/${artifactId}/zip`, true)) as Uint8Array;
    const receipt = validatePreviewReceipt((options.readReceiptZip ?? readPreviewReceiptZip)(bytes), proof, runId);
    if (
      receipt.version !== 2 ||
      receipt.deploymentId !== deploymentId ||
      receipt.sourceBaseSha !== options.sourceBaseSha ||
      receipt.sourceBaseRef !== options.sourceBaseRef
    )
      throw new Error('Preview receipt belongs to different source bases or publication.');
    const platforms = object(receipt.platforms, 'Receipt platforms');
    for (const platform of ['ios', 'android'] as const) {
      const identity = object(platforms[platform], `${platform} receipt`);
      if (identity.targetRef !== 'main' || identity.targetSha !== options.mainSha)
        throw new Error('Preview target base changed.');
      const cancellation = new AbortController();
      const deadline = setTimeout(() => cancellation.abort(new Error('Manifest verification timed out.')), 10000);
      try {
        // requestManifest shares the device headers. Abort on its first failed
        // request so publication's retry policy cannot delay this optional check.
        const once: typeof fetch = async (input, init) => {
          try {
            const response = await fetchImpl(input, init);
            if (!response.ok) {
              cancellation.abort(new Error(`Preview manifest returned ${response.status}.`));
              cancellation.signal.throwIfAborted();
            }
            return response;
          } catch (error) {
            cancellation.abort(error);
            throw error;
          }
        };
        const response = await requestManifest({
          manifestUrl: options.manifestUrl,
          platform,
          runtimeVersion: String(identity.runtimeVersion),
          appId: OTA_APP_ID,
          branch: String(receipt.branch),
          signal: cancellation.signal,
          fetchImpl: once,
        });
        const served = classifyServedManifest(new TextDecoder().decode(await boundedBody(response)));
        if (served.kind !== 'update') throw new Error('Preview no longer serves an update.');
        const head = readServedHead(served.manifest);
        if (
          head.id !== identity.updateId ||
          head.branch !== receipt.branch ||
          head.runtimeVersion !== identity.runtimeVersion ||
          head.launchAssetHash !== sha256HexToBase64Url(String(identity.bundleSha256))
        )
          throw new Error('Served preview differs from its frozen receipt.');
      } finally {
        clearTimeout(deadline);
      }
    }
    const current = object(await request(`/pulls/${options.pullRequest}`), 'Current PR');
    const currentBase = object(current.base, 'Current PR base');
    if (
      current.state !== 'open' ||
      object(current.head, 'Current PR head').sha !== options.headSha ||
      currentBase.sha !== options.sourceBaseSha ||
      currentBase.ref !== options.sourceBaseRef
    )
      throw new Error('PR moved or closed while checking reuse.');
    const latest = await request(
      `/deployments?environment=pr-preview&task=ota-preview-pr-${options.pullRequest}&per_page=1`,
    );
    if (!Array.isArray(latest) || object(latest[0], 'Latest preview').id !== deploymentId)
      throw new Error('Latest preview publication changed.');
    validatePreviewDeployment(
      latest[0],
      await request(`/deployments/${deploymentId}/statuses?per_page=1`),
      proof,
      deploymentId,
    );
    return {
      reuse: true,
      reason: 'Native app inputs and both served runtime variants are unchanged.',
      servedSha: previousSha,
    };
  } catch (error) {
    return { reuse: false, reason: error instanceof Error ? error.message : 'Preview reuse evidence is unreadable.' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let candidate: unknown;
  try {
    candidate = JSON.parse(process.env.OTA_REUSE_CANDIDATE ?? 'null') as unknown;
  } catch {
    candidate = null;
  }
  const decision = await checkPreviewReuse({
    candidate,
    repository: process.env.GITHUB_REPOSITORY ?? '',
    headSha: process.env.HEAD_SHA ?? '',
    mainSha: process.env.MAIN_SHA ?? '',
    sourceBaseSha: process.env.SOURCE_BASE_SHA ?? '',
    sourceBaseRef: process.env.SOURCE_BASE_REF ?? '',
    pullRequest: Number(process.env.PR_NUMBER),
    token: process.env.GH_TOKEN ?? '',
    manifestUrl: process.env.EXPO_UPDATES_URL ?? '',
  });
  console.log(
    `OTA preview reuse=${decision.reuse}: ${decision.reason}${decision.servedSha ? ` Serving ${decision.servedSha}.` : ''}`,
  );
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${decision.reuse}\n`);
}
