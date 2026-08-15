/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = '.github/workflows/export-board-snapshots.yml';
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');

function runBlock(stepName: string): string {
  const lines = workflowSource.split('\n');
  const stepIndex = lines.findIndex((line) => line === `      - name: ${stepName}`);
  if (stepIndex < 0) throw new Error(`missing workflow step: ${stepName}`);

  const runIndex = lines.findIndex((line, lineIndex) => lineIndex > stepIndex && line === '        run: |');
  if (runIndex < 0) throw new Error(`missing run block for workflow step: ${stepName}`);

  const blockLines: string[] = [];
  for (let lineIndex = runIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line && !line.startsWith('          ')) break;
    blockLines.push(line.startsWith('          ') ? line.slice(10) : line);
  }
  return blockLines.join('\n');
}

function runBash(script: string, environment: NodeJS.ProcessEnv) {
  return spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${script}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

describe('snapshot watchdog workflow shell boundaries', () => {
  it('encodes untrusted multiline reasons into exactly four workflow outputs', () => {
    const heartbeatScript = runBlock('Check snapshot publisher heartbeats');
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
    const notificationScript = runBlock('Notify snapshot watchdog failure or fallback');
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
});
