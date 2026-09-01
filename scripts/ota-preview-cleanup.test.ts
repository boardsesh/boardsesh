/// <reference types="node" />

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cleanupScript = resolve(import.meta.dirname, 'ota-preview-cleanup.ts');
const openServers: ReturnType<typeof createServer>[] = [];

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

function runCleanup(branch: string, environment: Partial<NodeJS.ProcessEnv>): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('node', ['--experimental-strip-types', cleanupScript, 'delete', '--branch', branch], {
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (exitCode) => resolveResult({ exitCode, stdout, stderr }));
  });
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  openServers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
        }),
    ),
  );
});

describe('ota-preview-cleanup CLI', () => {
  it('deletes a legacy channel before its branch and treats a missing channel as success', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === 'POST' && request.url === '/auth/login') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ token: 'dashboard-token' }));
        return;
      }
      if (request.method === 'DELETE' && request.url?.endsWith('/channels/pr-4792')) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.method === 'DELETE' && request.url?.endsWith('/branches/pr-4792')) {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(500);
      response.end('unexpected request');
    });
    const baseUrl = await listen(server);

    const result = await runCleanup('pr-4792', {
      OTA_BASE_URL: baseUrl,
      OTA_APP_ID: 'test-app',
      OTA_ADMIN_EMAIL: 'admin@example.test',
      OTA_ADMIN_PASSWORD: 'secret',
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('legacy channel "pr-4792" (already gone)');
    expect(requests).toEqual([
      'POST /auth/login',
      'DELETE /api/apps/test-app/channels/pr-4792',
      'DELETE /api/apps/test-app/branches/pr-4792',
    ]);
  });

  it('refuses a non-preview branch before attempting authentication', async () => {
    const result = await runCleanup('production', {
      OTA_BASE_URL: 'http://127.0.0.1:1',
      OTA_ADMIN_EMAIL: 'admin@example.test',
      OTA_ADMIN_PASSWORD: 'secret',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Refusing to delete non-preview branch "production"');
    expect(result.stderr).not.toContain('Admin login failed');
  });

  it.each(['pr-0', 'pr-01'])('refuses an impossible GitHub PR branch before authentication: %s', async (branch) => {
    const result = await runCleanup(branch, {
      OTA_BASE_URL: 'http://127.0.0.1:1',
      OTA_ADMIN_EMAIL: 'admin@example.test',
      OTA_ADMIN_PASSWORD: 'secret',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`Refusing to delete non-preview branch "${branch}"`);
    expect(result.stderr).not.toContain('Admin login failed');
  });
});
