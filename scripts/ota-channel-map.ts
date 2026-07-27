/// <reference types="node" />

/**
 * Control-plane channel↔branch management for the self-hosted expo-open-ota V3
 * server (updates.boardsesh.com). `eoas publish --branch X --channel Y` creates a
 * branch (holding the update) AND a channel, but leaves them UNMAPPED — a client
 * requesting that channel gets "No branch mapping found". Mapping is a
 * dashboard-admin operation and the app-scoped `eoo_` publish key CANNOT perform
 * it (it 403s: "This action requires a dashboard session"). This CLI does the
 * mapping (and teardown) headlessly for CI — notably the per-PR `pr-<n>` preview
 * channels — by logging in with the dashboard admin credentials to mint a JWT.
 *
 *   bun scripts/ota-channel-map.ts map    --channel pr-123 --branch pr-123
 *   bun scripts/ota-channel-map.ts delete --channel pr-123 --branch pr-123
 *
 * Both commands are idempotent. Env:
 *   OTA_BASE_URL          server base URL (a trailing /manifest is tolerated and
 *                         stripped); falls back to EXPO_UPDATES_URL the same way
 *                         (e.g. https://updates.boardsesh.com)
 *   OTA_APP_ID            app id the server routes on (default: the Boardsesh app UUID)
 *   OTA_ADMIN_EMAIL       dashboard admin email (POST /auth/login)
 *   OTA_ADMIN_PASSWORD    dashboard admin password
 *
 * The management API surface (control-plane): /auth/login (form-encoded) → {token};
 * GET/POST /api/apps/{appId}/branches|channels; POST
 * /api/apps/{appId}/branch/{branchId}/updateChannelBranchMapping; DELETE
 * /api/apps/{appId}/{channels|branches}/{name}. See docs/mobile-ota-updates.md.
 */

const DEFAULT_APP_ID = '007e6fd7-f200-448c-9449-8d48ba5d51fc';
const LOG = '[ota-channel-map]';

interface BranchRecord {
  branchName: string;
  branchId: string;
}
interface ChannelRecord {
  releaseChannelId: string;
  releaseChannelName: string;
  branchId?: string | null;
}

function fail(message: string): never {
  console.error(`${LOG} ${message}`);
  process.exit(1);
}

function resolveBaseUrl(): string {
  // Both sources may be the manifest endpoint (…/manifest) — the natural value to
  // paste is the same one EXPO_UPDATES_URL holds — so strip /manifest from either.
  const explicit = process.env.OTA_BASE_URL;
  if (explicit) return explicit.replace(/\/manifest\/?$/, '').replace(/\/+$/, '');
  const updatesUrl = process.env.EXPO_UPDATES_URL;
  if (!updatesUrl) fail('Set OTA_BASE_URL (or EXPO_UPDATES_URL). e.g. https://updates.boardsesh.com');
  return updatesUrl.replace(/\/manifest\/?$/, '').replace(/\/+$/, '');
}

function parseFlags(args: string[]): { channel: string | null; branch: string | null } {
  let channel: string | null = null;
  let branch: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--channel') channel = args[++index] ?? null;
    else if (arg.startsWith('--channel=')) channel = arg.slice('--channel='.length);
    else if (arg === '--branch') branch = args[++index] ?? null;
    else if (arg.startsWith('--branch=')) branch = arg.slice('--branch='.length);
  }
  return { channel, branch };
}

async function login(baseUrl: string): Promise<string> {
  const email = process.env.OTA_ADMIN_EMAIL;
  const password = process.env.OTA_ADMIN_PASSWORD;
  if (!email || !password) fail('map/delete need OTA_ADMIN_EMAIL + OTA_ADMIN_PASSWORD (dashboard admin login).');
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

async function apiJson<T>(baseUrl: string, token: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) fail(`GET ${path} failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as T;
}

async function findBranchId(baseUrl: string, token: string, appId: string, branch: string): Promise<string> {
  const branches = await apiJson<BranchRecord[]>(baseUrl, token, `/api/apps/${appId}/branches`);
  const match = branches.find((entry) => entry.branchName === branch);
  if (!match) {
    fail(`Branch "${branch}" not found. Publish to it first (eoas publish --branch ${branch} --channel <name>).`);
  }
  return match.branchId;
}

async function findChannel(
  baseUrl: string,
  token: string,
  appId: string,
  channel: string,
): Promise<ChannelRecord | null> {
  const channels = await apiJson<ChannelRecord[]>(baseUrl, token, `/api/apps/${appId}/channels`);
  return channels.find((entry) => entry.releaseChannelName === channel) ?? null;
}

async function mapCommand(baseUrl: string, appId: string, channel: string, branch: string): Promise<void> {
  const token = await login(baseUrl);
  const branchId = await findBranchId(baseUrl, token, appId, branch);
  const existing = await findChannel(baseUrl, token, appId, channel);

  if (existing && existing.branchId === branchId) {
    console.log(`${LOG} channel "${channel}" already mapped to branch "${branch}" — nothing to do.`);
    return;
  }

  if (!existing) {
    // Create the channel already pointing at the branch (create + map in one call).
    const response = await fetch(`${baseUrl}/api/apps/${appId}/channels`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channelName: channel, branchName: branch }),
    });
    if (!response.ok)
      fail(`Create+map channel failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
    console.log(`${LOG} created channel "${channel}" → branch "${branch}".`);
    return;
  }

  // Channel exists (e.g. eoas already created it) but points elsewhere/nowhere — remap it.
  const response = await fetch(`${baseUrl}/api/apps/${appId}/branch/${branchId}/updateChannelBranchMapping`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ releaseChannelId: existing.releaseChannelId, releaseChannelName: channel }),
  });
  if (!response.ok) fail(`Map channel failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
  console.log(`${LOG} mapped channel "${channel}" → branch "${branch}".`);
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

async function deleteCommand(baseUrl: string, appId: string, channel: string, branch: string | null): Promise<void> {
  const token = await login(baseUrl);
  // Channel (and its mapping) must go before the branch, or the branch delete is refused.
  await deleteResource(
    baseUrl,
    token,
    `/api/apps/${appId}/channels/${encodeURIComponent(channel)}`,
    `channel "${channel}"`,
  );
  if (branch) {
    await deleteResource(
      baseUrl,
      token,
      `/api/apps/${appId}/branches/${encodeURIComponent(branch)}`,
      `branch "${branch}"`,
    );
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== '--');
  const { channel, branch } = parseFlags(rest);
  const baseUrl = resolveBaseUrl();
  const appId = process.env.OTA_APP_ID || DEFAULT_APP_ID;

  if (command === 'map') {
    if (!channel || !branch) fail('map needs --channel <name> --branch <name>.');
    await mapCommand(baseUrl, appId, channel, branch);
  } else if (command === 'delete') {
    if (!channel) fail('delete needs --channel <name> (and optionally --branch <name>).');
    await deleteCommand(baseUrl, appId, channel, branch);
  } else {
    fail(`Unknown command "${command ?? ''}". Expected: map | delete.`);
  }
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
