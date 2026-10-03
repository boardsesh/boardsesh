import { createHash } from 'node:crypto';

import type { CollectBundle } from './discord-feedback';
import { validateTriageResult, type TriageDecision } from './discord-feedback-issue';

const GITHUB_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const REPLAY_FORMAT_VERSION = 1;

export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ReplayArtifactReference = {
  id: number;
  name: string;
  attempt: number;
  expired: boolean;
};

export type ReplayMetadata = {
  replayId: string;
  bundleSha256: string;
  decisionCount: number;
  artifactName: string;
};

export type ReplayProducerReference = {
  artifactId: string;
  artifactName: string;
  producer: 'collect' | 'triage';
};

type ReplayEnvelope = ReplayMetadata & {
  formatVersion: typeof REPLAY_FORMAT_VERSION;
  runId: string;
  originAttempt: number;
  channelId: string;
  triggerMessageId: string;
  decisionsSha256: string;
  serializedBundle: string;
  serializedDecisions: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseRunNumber(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseBundleAndDecisions(args: {
  serializedBundle: string;
  serializedDecisions: string;
  channelId: string;
  triggerMessageId: string;
}): { bundle: CollectBundle; decisions: TriageDecision[] } {
  let parsedBundle: unknown;
  let parsedDecisions: unknown;
  try {
    parsedBundle = JSON.parse(args.serializedBundle) as unknown;
    parsedDecisions = JSON.parse(args.serializedDecisions) as unknown;
  } catch {
    throw new Error('Replay bundle or decisions are not valid JSON.');
  }
  const bundleRecord = asRecord(parsedBundle);
  const command = asRecord(bundleRecord?.command);
  if (
    bundleRecord?.version !== 2 ||
    command?.channelId !== args.channelId ||
    command?.messageId !== args.triggerMessageId
  ) {
    throw new Error('Replay bundle coordinates do not match the workflow inputs.');
  }
  const bundle = parsedBundle as CollectBundle;
  const { accepted, rejected } = validateTriageResult(parsedDecisions, bundle);
  if (rejected.length > 0) {
    const reasons = rejected.map(({ issueIndex, reason }) => `#${issueIndex ?? '?'}: ${reason}`).join('; ');
    throw new Error(`Replay decisions failed validation: ${reasons}`);
  }
  return { bundle, decisions: accepted };
}

export function replayArtifactName(runId: string, attempt: number): string {
  parseRunNumber(runId, 'Workflow run ID');
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new Error('Workflow run attempt must be a positive integer.');
  return `discord-feedback-replay-${runId}-attempt-${attempt}`;
}

export function selectReplayProducer(args: {
  runId: string;
  runAttempt: number;
  collectArtifactId: string;
  collectArtifactName: string;
  triageArtifactId: string;
  triageArtifactName: string;
}): ReplayProducerReference {
  parseRunNumber(args.runId, 'Workflow run ID');
  if (!Number.isSafeInteger(args.runAttempt) || args.runAttempt < 1) {
    throw new Error('Workflow run attempt must be a positive integer.');
  }
  const collectProvided = Boolean(args.collectArtifactId || args.collectArtifactName);
  const producer = collectProvided ? 'collect' : 'triage';
  const artifactId = collectProvided ? args.collectArtifactId : args.triageArtifactId;
  const artifactName = collectProvided ? args.collectArtifactName : args.triageArtifactName;
  if (
    !artifactId ||
    !artifactName ||
    !/^\d+$/.test(artifactId) ||
    !Number.isSafeInteger(Number(artifactId)) ||
    Number(artifactId) < 1
  ) {
    throw new Error(
      'No complete validated replay artifact producer output is available; refusing to apply or acknowledge.',
    );
  }
  const prefix = `discord-feedback-replay-${args.runId}-attempt-`;
  if (!artifactName.startsWith(prefix)) {
    throw new Error('Replay artifact name does not match this workflow run.');
  }
  const artifactAttempt = Number(artifactName.slice(prefix.length));
  if (!Number.isSafeInteger(artifactAttempt) || artifactAttempt < 1 || artifactAttempt > args.runAttempt) {
    throw new Error('Replay artifact name does not match a valid producer attempt.');
  }
  return { artifactId, artifactName, producer };
}

function replayIdentity(args: {
  runId: string;
  originAttempt: number;
  channelId: string;
  triggerMessageId: string;
  bundleSha256: string;
  decisionsSha256: string;
  decisionCount: number;
}): string {
  return sha256(
    JSON.stringify([
      'discord-feedback-replay-v1',
      args.runId,
      args.originAttempt,
      args.channelId,
      args.triggerMessageId,
      args.bundleSha256,
      args.decisionsSha256,
      args.decisionCount,
    ]),
  );
}

export function sealReplayBatch(args: {
  runId: string;
  runAttempt: number;
  channelId: string;
  triggerMessageId: string;
  expectedBundleSha256: string;
  serializedBundle: string;
  serializedDecisions: string;
}): { serializedReplay: string; metadata: ReplayMetadata } {
  parseRunNumber(args.runId, 'Workflow run ID');
  if (!Number.isSafeInteger(args.runAttempt) || args.runAttempt < 1) {
    throw new Error('Workflow run attempt must be a positive integer.');
  }
  const bundleSha256 = sha256(args.serializedBundle);
  if (!args.expectedBundleSha256 || bundleSha256 !== args.expectedBundleSha256) {
    throw new Error('Replay bundle digest is missing or mismatched.');
  }
  const { decisions } = parseBundleAndDecisions(args);
  const decisionsSha256 = sha256(args.serializedDecisions);
  const replayId = replayIdentity({
    runId: args.runId,
    originAttempt: args.runAttempt,
    channelId: args.channelId,
    triggerMessageId: args.triggerMessageId,
    bundleSha256,
    decisionsSha256,
    decisionCount: decisions.length,
  });
  const artifactName = replayArtifactName(args.runId, args.runAttempt);
  const envelope: ReplayEnvelope = {
    formatVersion: REPLAY_FORMAT_VERSION,
    runId: args.runId,
    originAttempt: args.runAttempt,
    channelId: args.channelId,
    triggerMessageId: args.triggerMessageId,
    bundleSha256,
    decisionsSha256,
    decisionCount: decisions.length,
    replayId,
    artifactName,
    serializedBundle: args.serializedBundle,
    serializedDecisions: args.serializedDecisions,
  };
  return {
    serializedReplay: JSON.stringify(envelope, null, 2),
    metadata: { replayId, bundleSha256, decisionCount: decisions.length, artifactName },
  };
}

export function openReplayBatch(args: {
  serializedReplay: string;
  runId: string;
  runAttempt: number;
  channelId: string;
  triggerMessageId: string;
}): { serializedBundle: string; serializedDecisions: string; metadata: ReplayMetadata } {
  parseRunNumber(args.runId, 'Workflow run ID');
  if (!Number.isSafeInteger(args.runAttempt) || args.runAttempt < 1) {
    throw new Error('Workflow run attempt must be a positive integer.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.serializedReplay) as unknown;
  } catch {
    throw new Error('Original validated decision replay is not valid JSON.');
  }
  const envelope = asRecord(parsed);
  const requiredKeys = new Set([
    'formatVersion',
    'runId',
    'originAttempt',
    'channelId',
    'triggerMessageId',
    'bundleSha256',
    'decisionsSha256',
    'decisionCount',
    'replayId',
    'artifactName',
    'serializedBundle',
    'serializedDecisions',
  ]);
  if (!envelope || Object.keys(envelope).some((key) => !requiredKeys.has(key))) {
    throw new Error('Original validated decision replay has an unexpected envelope shape.');
  }
  const originAttempt = envelope.originAttempt;
  const decisionCount = envelope.decisionCount;
  const stringFields = [
    'runId',
    'channelId',
    'triggerMessageId',
    'bundleSha256',
    'decisionsSha256',
    'replayId',
    'artifactName',
    'serializedBundle',
    'serializedDecisions',
  ] as const;
  if (
    envelope.formatVersion !== REPLAY_FORMAT_VERSION ||
    typeof originAttempt !== 'number' ||
    !Number.isSafeInteger(originAttempt) ||
    originAttempt < 1 ||
    originAttempt > args.runAttempt ||
    typeof decisionCount !== 'number' ||
    !Number.isSafeInteger(decisionCount) ||
    decisionCount < 1 ||
    decisionCount > 5 ||
    stringFields.some((key) => typeof envelope[key] !== 'string')
  ) {
    throw new Error('Original validated decision replay has invalid fields.');
  }
  if (
    envelope.runId !== args.runId ||
    envelope.channelId !== args.channelId ||
    envelope.triggerMessageId !== args.triggerMessageId
  ) {
    throw new Error('Original validated decision replay belongs to a different run or Discord command.');
  }
  const serializedBundle = envelope.serializedBundle as string;
  const serializedDecisions = envelope.serializedDecisions as string;
  const bundleSha256 = sha256(serializedBundle);
  const decisionsSha256 = sha256(serializedDecisions);
  if (bundleSha256 !== envelope.bundleSha256 || decisionsSha256 !== envelope.decisionsSha256) {
    throw new Error('Original validated decision replay digest is mismatched.');
  }
  const { decisions } = parseBundleAndDecisions({
    serializedBundle,
    serializedDecisions,
    channelId: args.channelId,
    triggerMessageId: args.triggerMessageId,
  });
  if (decisions.length !== decisionCount) {
    throw new Error('Original validated decision replay count is mismatched.');
  }
  const replayId = replayIdentity({
    runId: args.runId,
    originAttempt,
    channelId: args.channelId,
    triggerMessageId: args.triggerMessageId,
    bundleSha256,
    decisionsSha256,
    decisionCount,
  });
  const artifactName = replayArtifactName(args.runId, originAttempt);
  if (replayId !== envelope.replayId || artifactName !== envelope.artifactName) {
    throw new Error('Original validated decision replay identity is mismatched.');
  }
  return {
    serializedBundle,
    serializedDecisions,
    metadata: { replayId, bundleSha256, decisionCount, artifactName },
  };
}

function parseRunArtifact(value: unknown, runId: string): ReplayArtifactReference | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== 'number' || !Number.isSafeInteger(record.id) || record.id < 1) return null;
  if (typeof record.name !== 'string' || record.expired !== false) return null;
  const run = asRecord(record.workflow_run);
  if (typeof run?.id === 'number' && String(run.id) !== runId) return null;
  const prefix = `discord-feedback-replay-${runId}-attempt-`;
  if (!record.name.startsWith(prefix)) return null;
  const attempt = Number(record.name.slice(prefix.length));
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null;
  return { id: record.id, name: record.name, attempt, expired: false };
}

export function selectPreviousReplayArtifact(args: {
  artifacts: unknown[];
  runId: string;
  runAttempt: number;
}): ReplayArtifactReference {
  parseRunNumber(args.runId, 'Workflow run ID');
  if (!Number.isSafeInteger(args.runAttempt) || args.runAttempt < 2) {
    throw new Error('A replay artifact can only be restored on a workflow retry.');
  }
  const candidates = args.artifacts
    .map((artifact) => parseRunArtifact(artifact, args.runId))
    .filter((artifact): artifact is ReplayArtifactReference => artifact !== null && artifact.attempt < args.runAttempt)
    .sort((left, right) => right.attempt - left.attempt);
  const selected = candidates[0];
  if (!selected) {
    throw new Error(
      'Original validated decision replay is missing or expired. This retry will not recollect Discord or rerun triage; inspect earlier attempts before starting another run.',
    );
  }
  return selected;
}

export class GitHubReplayArtifactClient {
  private readonly fetcher: Fetcher;
  private readonly owner: string;
  private readonly repository: string;
  private readonly token: string;
  private readonly apiBase: string;

  constructor(args: { repositoryFullName: string; token: string; fetcher?: Fetcher; apiBase?: string }) {
    const [owner, repository, extra] = args.repositoryFullName.split('/');
    if (!owner || !repository || extra) throw new Error('A valid owner/repository name is required.');
    if (!args.token.trim()) throw new Error('A GitHub token is required to locate replay artifacts.');
    this.owner = owner;
    this.repository = repository;
    this.token = args.token;
    this.fetcher = args.fetcher ?? fetch;
    this.apiBase = args.apiBase ?? GITHUB_API_BASE;
  }

  async findPreviousReplayArtifact(runId: string, runAttempt: number): Promise<ReplayArtifactReference> {
    parseRunNumber(runId, 'Workflow run ID');
    if (!Number.isSafeInteger(runAttempt) || runAttempt < 2) {
      throw new Error('A replay artifact can only be restored on a workflow retry.');
    }
    const artifacts: unknown[] = [];
    for (let page = 1; page <= 1000; page += 1) {
      const response = await this.fetcher(
        `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${this.token}`,
            'X-GitHub-Api-Version': API_VERSION,
          },
        },
      );
      if (!response.ok) throw new Error(`GitHub replay-artifact lookup failed with HTTP ${response.status}.`);
      let payload: unknown;
      try {
        payload = (await response.json()) as unknown;
      } catch {
        throw new Error('GitHub replay-artifact lookup returned invalid JSON.');
      }
      const record = asRecord(payload);
      if (!Array.isArray(record?.artifacts)) throw new Error('GitHub replay-artifact response has no artifact list.');
      artifacts.push(...record.artifacts);
      if (record.artifacts.length < 100) return selectPreviousReplayArtifact({ artifacts, runId, runAttempt });
    }
    throw new Error('GitHub replay-artifact listing exceeded its safe pagination limit.');
  }
}
