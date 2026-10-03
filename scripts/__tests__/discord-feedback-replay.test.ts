import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import { describe, expect, it, vi } from 'vitest';

import { bundleDigest } from '../discord-feedback-scan';
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
  expect(triage?.if).toContain("needs.collect.outputs.replay_artifact_id == ''");
  expect(triageValidation?.env?.BUNDLE_SHA256).toBe('${{ needs.collect.outputs.bundle_sha256 }}');
  expect(triageBundleDownload?.with?.['artifact-ids']).toBe('${{ needs.collect.outputs.bundle_artifact_id }}');
  expect(triageReplayUpload?.with?.name).toBe('${{ steps.seal_replay.outputs.artifact_name }}');
  expect(applyProducer?.env?.COLLECT_REPLAY_ID).toBe('${{ needs.collect.outputs.replay_artifact_id }}');
  expect(applyProducer?.env?.COLLECT_REPLAY_NAME).toBe('${{ needs.collect.outputs.replay_artifact_name }}');
  expect(applyProducer?.env?.TRIAGE_REPLAY_ID).toBe('${{ needs.triage.outputs.replay_artifact_id }}');
  expect(applyProducer?.env?.TRIAGE_REPLAY_NAME).toBe('${{ needs.triage.outputs.replay_artifact_name }}');
  expect(applyProducer?.run).toContain('--mode select-replay');
  expect(applyDownload?.with?.['artifact-ids']).toBe('${{ steps.replay_producer.outputs.artifact_id }}');
});

function decisionIndexes(serializedDecisions: string): number[] {
  const parsed = JSON.parse(serializedDecisions) as { decisions: Array<{ issueIndex: number }> };
  return parsed.decisions.map(({ issueIndex }) => issueIndex);
}
