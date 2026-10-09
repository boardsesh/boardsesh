import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { describe, expect, it, vi } from 'vitest';

import { bundleDigest, runCli } from '../discord-feedback-scan';
import {
  GitHubReplayArtifactClient,
  openReplayBatch,
  replayArtifactName,
  selectReplayProducer,
  sealReplayBatch,
  selectPreviousReplayArtifact,
  type Fetcher,
} from '../lib/discord-feedback-replay';

const RUN_ID = '1234567890';
const CHANNEL_ID = '500000000000000001';
const COMMAND_ID = '900000000000000001';

function bundleJson(): string {
  return JSON.stringify({
    version: 2,
    command: { channelId: CHANNEL_ID, messageId: COMMAND_ID },
  });
}

function decision(issueIndex: number) {
  return {
    commandMessageId: COMMAND_ID,
    issueIndex,
    verdict: 'bug',
    title: `Queue selection jumps ${issueIndex}`,
    body: `The queue skips climb ${issueIndex} after logging a send.`,
    labels: ['mobile'],
    duplicateOf: null,
    rationale: 'The maintainer requested separate issues.',
  };
}

function artifact(id: number, runId: string, attempt: number, expired = false) {
  return {
    id,
    name: replayArtifactName(runId, attempt),
    expired,
    workflow_run: { id: Number(runId) },
  };
}

describe('validated decision replay', () => {
  it('seals the original ordered batch and restores its count and identity', () => {
    const serializedBundle = bundleJson();
    const serializedDecisions = JSON.stringify({ decisions: [decision(1), decision(2)] });
    const sealed = sealReplayBatch({
      runId: RUN_ID,
      runAttempt: 1,
      channelId: CHANNEL_ID,
      triggerMessageId: COMMAND_ID,
      expectedBundleSha256: bundleDigest(serializedBundle),
      serializedBundle,
      serializedDecisions,
    });

    const restored = openReplayBatch({
      serializedReplay: sealed.serializedReplay,
      runId: RUN_ID,
      runAttempt: 2,
      channelId: CHANNEL_ID,
      triggerMessageId: COMMAND_ID,
    });

    expect(restored.serializedBundle).toBe(serializedBundle);
    expect(restored.serializedDecisions).toBe(serializedDecisions);
    expect(restored.metadata).toEqual(sealed.metadata);
    expect(decisionIndexes(restored.serializedDecisions)).toEqual([1, 2]);
  });

  it.each([
    ['reordered', { decisions: [decision(2), decision(1)] }],
    ['shortened', { decisions: [decision(1)] }],
  ])('keeps the sealed two-topic batch when a retry model result is %s', (_label, retryModelResult) => {
    const serializedBundle = bundleJson();
    const serializedDecisions = JSON.stringify({ decisions: [decision(1), decision(2)] });
    const sealed = sealReplayBatch({
      runId: RUN_ID,
      runAttempt: 1,
      channelId: CHANNEL_ID,
      triggerMessageId: COMMAND_ID,
      expectedBundleSha256: bundleDigest(serializedBundle),
      serializedBundle,
      serializedDecisions,
    });
    const restored = openReplayBatch({
      serializedReplay: sealed.serializedReplay,
      runId: RUN_ID,
      runAttempt: 2,
      channelId: CHANNEL_ID,
      triggerMessageId: COMMAND_ID,
    });

    expect(JSON.stringify(retryModelResult)).not.toBe(restored.serializedDecisions);
    expect(decisionIndexes(restored.serializedDecisions)).toHaveLength(2);
    expect(restored.metadata.decisionCount).toBe(2);
    expect(restored.metadata.replayId).toBe(sealed.metadata.replayId);
  });

  it('rejects a modified, shortened decision payload instead of changing the original count', () => {
    const serializedBundle = bundleJson();
    const sealed = sealReplayBatch({
      runId: RUN_ID,
      runAttempt: 1,
      channelId: CHANNEL_ID,
      triggerMessageId: COMMAND_ID,
      expectedBundleSha256: bundleDigest(serializedBundle),
      serializedBundle,
      serializedDecisions: JSON.stringify({ decisions: [decision(1), decision(2)] }),
    });
    const tampered = JSON.parse(sealed.serializedReplay) as Record<string, unknown>;
    tampered.serializedDecisions = JSON.stringify({ decisions: [decision(1)] });

    expect(() =>
      openReplayBatch({
        serializedReplay: JSON.stringify(tampered),
        runId: RUN_ID,
        runAttempt: 2,
        channelId: CHANNEL_ID,
        triggerMessageId: COMMAND_ID,
      }),
    ).toThrow(/digest is mismatched/);
  });
});

describe('retry artifact selection', () => {
  it('selects the latest unexpired earlier producer artifact', () => {
    const selected = selectPreviousReplayArtifact({
      runId: RUN_ID,
      runAttempt: 4,
      artifacts: [
        artifact(1, RUN_ID, 1),
        artifact(2, RUN_ID, 2, true),
        artifact(3, RUN_ID, 3),
        artifact(4, RUN_ID, 4),
        artifact(5, '9999999999', 3),
        { id: 6, name: `discord-bundle-${RUN_ID}-attempt-3`, expired: false },
      ],
    });

    expect(selected).toEqual({
      id: 3,
      name: replayArtifactName(RUN_ID, 3),
      attempt: 3,
      expired: false,
    });
  });

  it.each([
    ['missing', []],
    ['expired', [artifact(1, RUN_ID, 1, true)]],
  ])('fails closed when the prior replay artifact is %s', (_label, artifacts) => {
    expect(() => selectPreviousReplayArtifact({ artifacts, runId: RUN_ID, runAttempt: 2 })).toThrow(
      /missing or expired.*will not recollect Discord or rerun triage/,
    );
  });

  it.each([
    {
      path: 'whole-workflow retry',
      runAttempt: 3,
      collectArtifactId: '33',
      collectArtifactName: replayArtifactName(RUN_ID, 3),
      triageArtifactId: '',
      triageArtifactName: '',
      expectedProducer: 'collect',
      expectedId: '33',
    },
    {
      path: 'failed-apply-only retry',
      runAttempt: 2,
      collectArtifactId: '',
      collectArtifactName: '',
      triageArtifactId: '11',
      triageArtifactName: replayArtifactName(RUN_ID, 1),
      expectedProducer: 'triage',
      expectedId: '11',
    },
  ])('uses the actual producer output for a $path', (path) => {
    const selected = selectReplayProducer({
      runId: RUN_ID,
      runAttempt: path.runAttempt,
      collectArtifactId: path.collectArtifactId,
      collectArtifactName: path.collectArtifactName,
      triageArtifactId: path.triageArtifactId,
      triageArtifactName: path.triageArtifactName,
    });

    expect(selected).toEqual({
      artifactId: path.expectedId,
      artifactName: path.expectedProducer === 'collect' ? path.collectArtifactName : path.triageArtifactName,
      producer: path.expectedProducer,
    });
  });

  it('fails closed when producer outputs are missing or only partly present', () => {
    expect(() =>
      selectReplayProducer({
        runId: RUN_ID,
        runAttempt: 2,
        collectArtifactId: '',
        collectArtifactName: '',
        triageArtifactId: '',
        triageArtifactName: '',
      }),
    ).toThrow(/No complete validated replay artifact producer output/);
    expect(() =>
      selectReplayProducer({
        runId: RUN_ID,
        runAttempt: 2,
        collectArtifactId: '11',
        collectArtifactName: '',
        triageArtifactId: '22',
        triageArtifactName: replayArtifactName(RUN_ID, 1),
      }),
    ).toThrow(/No complete validated replay artifact producer output/);
  });

  it('finds a prior producer artifact through the run-scoped GitHub API', async () => {
    const fetcher = vi.fn<Fetcher>(async () =>
      Response.json({ artifacts: [artifact(22, RUN_ID, 2), artifact(11, RUN_ID, 1)] }),
    );
    const client = new GitHubReplayArtifactClient({
      repositoryFullName: 'boardsesh/boardsesh',
      token: 'test-token',
      fetcher,
    });

    await expect(client.findPreviousReplayArtifact(RUN_ID, 3)).resolves.toEqual({
      id: 22,
      name: replayArtifactName(RUN_ID, 2),
      attempt: 2,
      expired: false,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(`/actions/runs/${RUN_ID}/artifacts?per_page=100&page=1`);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer test-token');
  });

  it('does not choose an expired artifact when the run has no reusable replay', async () => {
    const client = new GitHubReplayArtifactClient({
      repositoryFullName: 'boardsesh/boardsesh',
      token: 'test-token',
      fetcher: vi.fn(async () => Response.json({ artifacts: [artifact(22, RUN_ID, 1, true)] })),
    });

    await expect(client.findPreviousReplayArtifact(RUN_ID, 2)).rejects.toThrow(/missing or expired/);
  });
});

type WorkflowStep = {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  if?: string;
  outputs?: Record<string, unknown>;
  steps?: WorkflowStep[];
};

type WorkflowDefinition = { jobs: Record<string, WorkflowJob> };

it('wires producer IDs through whole-run and failed-job replay paths', () => {
  const workflowText = readFileSync(
    new URL('../../.github/workflows/discord-feedback-issues.yml', import.meta.url),
    'utf8',
  );
  const workflow = parseYaml(workflowText) as unknown as WorkflowDefinition;
  const collect = workflow.jobs.collect;
  const triage = workflow.jobs.triage;
  const apply = workflow.jobs.apply;
  const collectSteps = collect?.steps ?? [];
  const triageSteps = triage?.steps ?? [];
  const applySteps = apply?.steps ?? [];
  const triageValidation = triageSteps.find((step) => step.name === 'Validate triage decisions');
  const collectUpload = collectSteps.find((step) => step.id === 'upload_bundle');
  const collectBundleName = collectSteps.find((step) => step.id === 'bundle_name');
  const collectReplayUpload = collectSteps.find((step) => step.id === 'upload_replay');
  const previousReplayDownload = collectSteps.find((step) => step.id === 'download_previous_replay');
  const triageBundleDownload = triageSteps.find((step) => step.uses === 'actions/download-artifact@v4');
  const triageReplayUpload = triageSteps.find((step) => step.id === 'upload_replay');
  const applyProducer = applySteps.find((step) => step.id === 'replay_producer');
  const applyDownload = applySteps.find((step) => step.id === 'download_replay');

  expect(collect?.outputs?.bundle_artifact_id).toContain('steps.upload_bundle.outputs.artifact-id');
  expect(collectBundleName?.run).toContain('GITHUB_RUN_ATTEMPT');
  expect(collectUpload?.with?.name).toBe('${{ steps.bundle_name.outputs.name }}');
  expect(collectReplayUpload?.with?.name).toBe('${{ steps.restore.outputs.artifact_name }}');
  expect(previousReplayDownload?.with?.['artifact-ids']).toBe('${{ steps.previous_replay.outputs.artifact_id }}');
  expect(previousReplayDownload?.with?.['merge-multiple']).toBe(true);
  expect(previousReplayDownload?.with?.['github-token']).toBeUndefined();
  expect(previousReplayDownload?.with?.repository).toBeUndefined();
  expect(previousReplayDownload?.with?.['run-id']).toBeUndefined();
  expect(triage?.if).toContain("needs.collect.outputs.replay_artifact_id == ''");
  expect(triageValidation?.env?.BUNDLE_SHA256).toBe('${{ needs.collect.outputs.bundle_sha256 }}');
  expect(triageBundleDownload?.with?.['artifact-ids']).toBe('${{ needs.collect.outputs.bundle_artifact_id }}');
  expect(triageBundleDownload?.with?.['merge-multiple']).toBe(true);
  expect(triageReplayUpload?.with?.name).toBe('${{ steps.seal_replay.outputs.artifact_name }}');
  expect(applyProducer?.env?.COLLECT_REPLAY_ID).toBe('${{ needs.collect.outputs.replay_artifact_id }}');
  expect(applyProducer?.env?.COLLECT_REPLAY_NAME).toBe('${{ needs.collect.outputs.replay_artifact_name }}');
  expect(applyProducer?.env?.TRIAGE_REPLAY_ID).toBe('${{ needs.triage.outputs.replay_artifact_id }}');
  expect(applyProducer?.env?.TRIAGE_REPLAY_NAME).toBe('${{ needs.triage.outputs.replay_artifact_name }}');
  expect(applyProducer?.run).toContain('--mode select-replay');
  expect(applyDownload?.with?.['artifact-ids']).toBe('${{ steps.replay_producer.outputs.artifact_id }}');
  expect(applyDownload?.with?.['merge-multiple']).toBe(true);
  expect(applyDownload?.with?.['github-token']).toBeUndefined();
  expect(applyDownload?.with?.repository).toBeUndefined();
  expect(applyDownload?.with?.['run-id']).toBeUndefined();
});

it('materializes artifact extraction paths and runs the real validate/restore CLIs', async () => {
  const workflowText = readFileSync(
    new URL('../../.github/workflows/discord-feedback-issues.yml', import.meta.url),
    'utf8',
  );
  const workflow = parseYaml(workflowText) as unknown as WorkflowDefinition;
  const collectSteps = workflow.jobs.collect?.steps ?? [];
  const triageSteps = workflow.jobs.triage?.steps ?? [];
  const applySteps = workflow.jobs.apply?.steps ?? [];
  const previousReplayDownload = collectSteps.find((step) => step.id === 'download_previous_replay');
  const triageBundleDownload = triageSteps.find((step) => step.uses === 'actions/download-artifact@v4');
  const applyReplayDownload = applySteps.find((step) => step.id === 'download_replay');
  if (!previousReplayDownload || !triageBundleDownload || !applyReplayDownload) {
    throw new Error('Expected one-artifact downloads are missing from the workflow.');
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-discord-artifact-layout-'));
  const serializedBundle = bundleJson();
  const serializedDecisions = JSON.stringify({ decisions: [decision(1)] });
  const sealed = sealReplayBatch({
    runId: RUN_ID,
    runAttempt: 1,
    channelId: CHANNEL_ID,
    triggerMessageId: COMMAND_ID,
    expectedBundleSha256: bundleDigest(serializedBundle),
    serializedBundle,
    serializedDecisions,
  });

  try {
    const triagePath = join(temporaryDirectory, 'triage');
    const triageBundlePath = materializeActionArtifactFile(
      triageBundleDownload,
      triagePath,
      `discord-bundle-${RUN_ID}-attempt-1`,
      'discord-bundle.json',
      serializedBundle,
    );
    const triageDecisionsPath = join(triagePath, 'discord-decisions.json');
    writeFileSync(triageDecisionsPath, serializedDecisions);
    const validateExitCode = await runCli(
      [
        '--mode',
        'validate',
        '--channel-id',
        CHANNEL_ID,
        '--trigger-message-id',
        COMMAND_ID,
        '--bundle',
        triageBundlePath,
        '--decisions',
        triageDecisionsPath,
        '--bundle-sha256',
        bundleDigest(serializedBundle),
      ],
      { NODE_ENV: 'test' },
      { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
    );
    expect(validateExitCode).toBe(0);

    const previousReplayPath = materializeActionArtifactFile(
      previousReplayDownload,
      join(temporaryDirectory, 'previous-replay'),
      sealed.metadata.artifactName,
      'discord-replay.json',
      sealed.serializedReplay,
    );
    const previousRestore = await restoreReplayFromDownloadedArtifact(
      previousReplayPath,
      join(temporaryDirectory, 'collect-restore'),
    );
    expect(readFileSync(previousRestore.bundlePath, 'utf8')).toBe(serializedBundle);
    expect(readFileSync(previousRestore.decisionsPath, 'utf8')).toBe(serializedDecisions);

    const applyReplayPath = materializeActionArtifactFile(
      applyReplayDownload,
      join(temporaryDirectory, 'validated-replay'),
      sealed.metadata.artifactName,
      'discord-replay.json',
      sealed.serializedReplay,
    );
    const applyRestore = await restoreReplayFromDownloadedArtifact(
      applyReplayPath,
      join(temporaryDirectory, 'apply-restore'),
    );
    expect(readFileSync(applyRestore.bundlePath, 'utf8')).toBe(serializedBundle);
    expect(readFileSync(applyRestore.decisionsPath, 'utf8')).toBe(serializedDecisions);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

function decisionIndexes(serializedDecisions: string): number[] {
  const parsed = JSON.parse(serializedDecisions) as { decisions: Array<{ issueIndex: number }> };
  return parsed.decisions.map(({ issueIndex }) => issueIndex);
}

function materializeActionArtifactFile(
  step: WorkflowStep,
  downloadPath: string,
  artifactName: string,
  fileName: string,
  contents: string,
): string {
  const extractedDirectory = step.with?.['merge-multiple'] === true ? downloadPath : join(downloadPath, artifactName);
  mkdirSync(extractedDirectory, { recursive: true });
  writeFileSync(join(extractedDirectory, fileName), contents);
  return join(downloadPath, fileName);
}

async function restoreReplayFromDownloadedArtifact(replayPath: string, outputDirectory: string) {
  mkdirSync(outputDirectory, { recursive: true });
  const bundlePath = join(outputDirectory, 'discord-bundle.json');
  const decisionsPath = join(outputDirectory, 'discord-decisions.json');
  const exitCode = await runCli(
    [
      '--mode',
      'restore-replay',
      '--run-id',
      RUN_ID,
      '--run-attempt',
      '2',
      '--channel-id',
      CHANNEL_ID,
      '--trigger-message-id',
      COMMAND_ID,
      '--replay',
      replayPath,
      '--bundle-out',
      bundlePath,
      '--decisions-out',
      decisionsPath,
    ],
    { NODE_ENV: 'test' },
    { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
  );
  expect(exitCode).toBe(0);
  return { bundlePath, decisionsPath };
}
