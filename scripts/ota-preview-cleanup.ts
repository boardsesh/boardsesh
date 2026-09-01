/// <reference types="node" />

/**
 * Delete a per-PR xprem branch and, during the migration window, a legacy
 * same-named channel. The channel must go first because an existing mapping can
 * prevent branch deletion. Both deletes are idempotent.
 *
 *   node --experimental-strip-types scripts/ota-preview-cleanup.ts delete --branch pr-123
 */

const DEFAULT_APP_ID = '007e6fd7-f200-448c-9449-8d48ba5d51fc';
const LOG = '[ota-preview-cleanup]';

function fail(message: string): never {
  console.error(`${LOG} ${message}`);
  process.exit(1);
}

function resolveBaseUrl(): string {
  const configuredUrl = process.env.OTA_BASE_URL || process.env.EXPO_UPDATES_URL;
  if (!configuredUrl) fail('Set OTA_BASE_URL (or EXPO_UPDATES_URL).');
  return configuredUrl.replace(/\/manifest\/?$/, '').replace(/\/+$/, '');
}

function parseBranch(args: string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--branch') return args[index + 1] ?? null;
    if (arg.startsWith('--branch=')) return arg.slice('--branch='.length);
  }
  return null;
}

async function login(baseUrl: string): Promise<string> {
  const email = process.env.OTA_ADMIN_EMAIL;
  const password = process.env.OTA_ADMIN_PASSWORD;
  if (!email || !password) fail('Delete needs OTA_ADMIN_EMAIL + OTA_ADMIN_PASSWORD.');

  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password }).toString(),
  });
  if (!response.ok) fail(`Admin login failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
  const payload = (await response.json()) as { token?: string };
  if (!payload.token) fail('Admin login returned no token.');
  return payload.token;
}

async function deleteResource(baseUrl: string, token: string, path: string, label: string): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.ok || response.status === 404) {
    console.log(`${LOG} deleted ${label}${response.status === 404 ? ' (already gone)' : ''}.`);
    return;
  }
  fail(`Delete ${label} failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
}

async function deletePreview(baseUrl: string, appId: string, branch: string): Promise<void> {
  if (!/^pr-[1-9][0-9]*$/.test(branch)) fail(`Refusing to delete non-preview branch "${branch}".`);
  const token = await login(baseUrl);

  // Transitional cleanup for previews created by the retired channel-mapping
  // workflow. A 404 is expected for new branch-surfing-only previews.
  await deleteResource(
    baseUrl,
    token,
    `/api/apps/${appId}/channels/${encodeURIComponent(branch)}`,
    `legacy channel "${branch}"`,
  );
  await deleteResource(
    baseUrl,
    token,
    `/api/apps/${appId}/branches/${encodeURIComponent(branch)}`,
    `branch "${branch}"`,
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== '--');
  if (command !== 'delete') fail(`Unknown command "${command ?? ''}". Expected: delete.`);
  const branch = parseBranch(rest);
  if (!branch) fail('Delete needs --branch <pr-number>.');
  await deletePreview(resolveBaseUrl(), process.env.OTA_APP_ID || DEFAULT_APP_ID, branch);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
