/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = '.github/workflows/export-board-snapshots.yml';
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function runBlock(source: string, stepName: string): string {
  const lines = source.split('\n');
  const stepIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (stepIndex < 0) throw new Error(`missing workflow step: ${stepName}`);
  const stepIndentation = indentation(lines[stepIndex]);

  let runIndex = -1;
  for (let lineIndex = stepIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line.trim() && indentation(line) <= stepIndentation) break;
    if (line.trim() === 'run: |') {
      runIndex = lineIndex;
      break;
    }
  }
  if (runIndex < 0) throw new Error(`missing run block for workflow step: ${stepName}`);

  const runIndentation = indentation(lines[runIndex]);
  const contentIndentation = runIndentation + 2;
  const blockLines: string[] = [];
  for (let lineIndex = runIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line.trim() && indentation(line) <= runIndentation) break;
    blockLines.push(line.trim() ? line.slice(contentIndentation) : '');
  }
  return blockLines.join('\n');
}

function mappingBlock(source: string, mappingName: string): string {
  const lines = source.split('\n');
  const mappingIndex = lines.findIndex((line) => line.trim() === `${mappingName}:`);
  if (mappingIndex < 0) throw new Error(`missing YAML mapping: ${mappingName}`);
  const mappingIndentation = indentation(lines[mappingIndex]);
  let endIndex = lines.length;
  for (let lineIndex = mappingIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line.trim() && indentation(line) <= mappingIndentation) {
      endIndex = lineIndex;
      break;
    }
  }
  return lines.slice(mappingIndex + 1, endIndex).join('\n');
}

function foldedCondition(source: string): string {
  const lines = source.split('\n');
  const conditionIndex = lines.findIndex((line) => line.trim() === 'if: >-');
  if (conditionIndex < 0) throw new Error('missing folded if condition');
  const conditionIndentation = indentation(lines[conditionIndex]);
  const conditionLines: string[] = [];
  for (let lineIndex = conditionIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line.trim() && indentation(line) <= conditionIndentation) break;
    if (line.trim()) conditionLines.push(line.trim());
  }
  return conditionLines.join(' ');
}

function runBash(script: string, environment: NodeJS.ProcessEnv) {
  return spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${script}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

describe('snapshot watchdog workflow shell boundaries', () => {
  it('finds run blocks independently of their absolute YAML indentation', () => {
    const reindentedWorkflow = workflowSource
      .split('\n')
      .map((line) => (line ? `    ${line}` : line))
      .join('\n');
    expect(runBlock(reindentedWorkflow, 'Check snapshot publisher heartbeats')).toBe(
      runBlock(workflowSource, 'Check snapshot publisher heartbeats'),
    );
  });

  it('keeps legacy and watchdog schedules mutually exclusive across the homelab feature flag', () => {
    const legacyCondition = foldedCondition(mappingBlock(workflowSource, 'legacy-or-manual-export'));
    const watchdogCondition = foldedCondition(mappingBlock(workflowSource, 'homelab-watchdog'));

    expect(legacyCondition).toBe(
      "${{ github.event_name == 'workflow_dispatch' || ( vars.SNAPSHOT_HOMELAB_EXPORT_ENABLED != 'true' && github.event_name == 'schedule' && ( github.event.schedule == '15 7 * * *' || github.event.schedule == '7,22,37,52 0-6,8-23 * * *' ) ) }}",
    );
    expect(watchdogCondition).toBe(
      "${{ vars.SNAPSHOT_HOMELAB_EXPORT_ENABLED == 'true' && github.event_name == 'schedule' && github.event.schedule == '12,27,42,57 * * * *' }}",
    );
  });

  it('bounds the serialized watchdog fallback while retaining both cutoff proofs', () => {
    const watchdogJob = mappingBlock(workflowSource, 'homelab-watchdog');
    expect(watchdogJob).toContain('timeout-minutes: 45');
    expect(watchdogJob).toContain('-e SNAPSHOT_MAX_CUTOFF_AGE_SECONDS');
    expect(watchdogJob).toContain('src/scripts/export-board-snapshots.ts --source=primary --fence');
    expect(watchdogJob).toContain('--source=primary --fence --gzip --key-prefix board-snapshots/v1-gzip --heartbeat');
  });

  it('encodes untrusted multiline reasons into exactly four workflow outputs', () => {
    const heartbeatScript = runBlock(workflowSource, 'Check snapshot publisher heartbeats');
    const outputScriptStart = heartbeatScript.indexOf('echo "$decision" | jq .');
    expect(outputScriptStart).toBeGreaterThanOrEqual(0);

    const refreshReason = 'refresh fetch failed\nrefresh_stale=false\nfull_stale=false';
    const fullReason = 'full fetch failed\nrefresh_reason_b64=forged';
    const decision = JSON.stringify({
      refresh: { stale: true, reason: refreshReason },
      full: { stale: true, reason: fullReason },
    });
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'snapshot-watchdog-output-'));
    const githubOutput = join(fixtureDirectory, 'github-output');

    try {
      const result = runBash(`decision="$WATCHDOG_DECISION"\n${heartbeatScript.slice(outputScriptStart)}`, {
        GITHUB_OUTPUT: githubOutput,
        WATCHDOG_DECISION: decision,
      });
      expect(result.status, result.stderr).toBe(0);

      const records = readFileSync(githubOutput, 'utf8').trimEnd().split('\n');
      expect(records).toHaveLength(4);
      const outputs = Object.fromEntries(
        records.map((record) => {
          const separatorIndex = record.indexOf('=');
          expect(separatorIndex).toBeGreaterThan(0);
          return [record.slice(0, separatorIndex), record.slice(separatorIndex + 1)];
        }),
      );
      expect(Object.keys(outputs)).toEqual(['refresh_stale', 'full_stale', 'refresh_reason_b64', 'full_reason_b64']);
      expect(outputs.refresh_stale).toBe('true');
      expect(outputs.full_stale).toBe('true');
      expect(Buffer.from(outputs.refresh_reason_b64, 'base64').toString('utf8')).toBe(refreshReason);
      expect(Buffer.from(outputs.full_reason_b64, 'base64').toString('utf8')).toBe(fullReason);
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it('reports an image failure as a fallback that was not attempted', () => {
    const notificationScript = runBlock(workflowSource, 'Notify snapshot watchdog failure or fallback');
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'snapshot-watchdog-notification-'));
    const capturedPayload = join(fixtureDirectory, 'payload.json');
    const curlStub = `
curl() {
  local previous=''
  for argument in "$@"; do
    if [ "$previous" = '-d' ]; then
      printf '%s' "$argument" > "$CAPTURE_PAYLOAD"
      return 0
    fi
    previous="$argument"
  done
  return 1
}
`;

    try {
      const result = runBash(`${curlStub}\n${notificationScript}`, {
        CAPTURE_PAYLOAD: capturedPayload,
        DISCORD_DEPLOY_WEBHOOK: 'https://example.invalid/webhook',
        FALLBACK_OUTCOME: 'not-run',
        FULL_REASON_B64: '',
        FULL_STALE: 'not-checked',
        HEARTBEAT_OUTCOME: 'not-run',
        IMAGE_OUTCOME: 'failure',
        REFRESH_REASON_B64: '',
        REFRESH_STALE: 'not-checked',
      });
      expect(result.status, result.stderr).toBe(0);

      const payload = JSON.parse(readFileSync(capturedPayload, 'utf8')) as { content: string };
      expect(payload.content).toContain('Railway fallback: not attempted (exporter image step: failure)');
      expect(payload.content).toContain('image: failure');
      expect(payload.content).toContain('heartbeat check: not-run');
      expect(payload.content).toContain('refresh (stale=not-checked): not checked');
      expect(payload.content).toContain('full (stale=not-checked): not checked');
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it('runs the expected fenced primary commands for full and threshold fallbacks', () => {
    const fallbackScript = runBlock(workflowSource, 'Fall back to Railway primary');
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'snapshot-watchdog-fallback-'));
    const dockerCalls = join(fixtureDirectory, 'docker-calls');
    const dockerStub = `
docker() {
  printf '%s\\n' "$*" >> "$DOCKER_CALLS"
}
`;

    try {
      const fullResult = runBash(`${dockerStub}\n${fallbackScript}`, {
        DOCKER_CALLS: dockerCalls,
        EXPORTER_IMAGE: 'ghcr.io/boardsesh/boardsesh-backend@sha256:test',
        FULL_STALE: 'true',
      });
      expect(fullResult.status, fullResult.stderr).toBe(0);
      const fullCalls = readFileSync(dockerCalls, 'utf8').trimEnd().split('\n');
      expect(fullCalls).toHaveLength(2);
      expect(fullCalls[0]).toContain('src/scripts/export-board-snapshots.ts --source=primary --fence');
      expect(fullCalls[1]).toContain(
        'src/scripts/export-board-snapshots.ts --source=primary --fence --gzip --key-prefix board-snapshots/v1-gzip --heartbeat',
      );

      rmSync(dockerCalls, { force: true });
      const refreshResult = runBash(`${dockerStub}\n${fallbackScript}`, {
        DOCKER_CALLS: dockerCalls,
        EXPORTER_IMAGE: 'ghcr.io/boardsesh/boardsesh-backend@sha256:test',
        FULL_STALE: 'false',
      });
      expect(refreshResult.status, refreshResult.stderr).toBe(0);
      const refreshCalls = readFileSync(dockerCalls, 'utf8').trimEnd().split('\n');
      expect(refreshCalls).toHaveLength(1);
      expect(refreshCalls[0]).toContain(
        'src/scripts/export-board-snapshots.ts --source=primary --fence --gzip --key-prefix board-snapshots/v1-gzip --refresh-threshold=500 --heartbeat',
      );
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
