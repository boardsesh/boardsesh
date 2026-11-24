/// <reference types="node" />

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

const fixturePath = fileURLToPath(new URL('./fixtures/edge-socket.ts', import.meta.url));
const edgePath = fileURLToPath(new URL('../../packages/web/partner-oauth-e2e/edge.ts', import.meta.url));
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

async function runFixture(scenario: string, resetMode: string) {
  const scratchDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-edge-socket-'));
  try {
    return await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', tsxLoader, fixturePath, edgePath, scenario, resetMode, scratchDirectory],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (exitCode, signal) => {
        clearTimeout(timeout);
        resolve({ exitCode, signal, stdout, stderr });
      });
    });
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

describe('edge ownership of rejected connection errors', () => {
  it.each([
    ['connect-host', 'peer-reset'],
    ['connect-port', 'peer-reset'],
    ['upgrade-host', 'peer-close'],
  ])(
    'keeps serving after %s closes with %s',
    async (scenario, resetMode) => {
      const childResult = await runFixture(scenario, resetMode);
      expect(childResult, childResult.stderr).toMatchObject({ exitCode: 0, signal: null });
      expect(JSON.parse(childResult.stdout.trim())).toEqual({
        scenario,
        resetMode,
        protocolRefused: true,
        healthyStatus: 200,
        closed: true,
      });
    },
    15_000,
  );
});
