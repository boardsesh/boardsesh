/// <reference types="node" />

/**
 * A client for the xprem admin-session API: the endpoints the dashboard at
 * `/dashboard` calls with the JWT that `POST /auth/login` returns.
 *
 * None of this is documented by xprem. Every path, method and payload below was
 * read out of the dashboard's own API client class (the one whose `appScope()`
 * returns `/api/apps/{appId}`), in the public bundle served by our server:
 *
 *   bundle:  https://updates.boardsesh.com/dashboard/assets/index-Cnt5-VRw.js
 *   server:  xprem 3.2.5 (OTA_SERVER_VERSION in infra/railway/config.ts)
 *   read on: 2026-10-05
 *
 * Two checks stand behind that reading, and they cover different things:
 *   - scripts/lib/xprem-admin.test.ts pins the requests THIS file makes, against
 *     a fake server. It catches an accidental edit here. It cannot notice the
 *     real server changing.
 *   - scripts/ota-admin-api-probe.ts (`vp run ota:api-probe`) downloads the live
 *     dashboard bundle and checks that every path in {@link XPREM_BUNDLE_MARKERS}
 *     is still in it. The daily drift workflow runs it, so a server upgrade that
 *     moves an endpoint goes red within a day.
 * Neither proves a response shape. Those are parsed strictly below, so a changed
 * shape fails loudly on first use.
 *
 * `{app}` is `/api/apps/{appId}`. Names are URL-encoded path segments.
 *
 *   POST {base}/auth/login                       form: email, password -> { token, refreshToken }
 *   GET  {app}/channels                          -> [{ releaseChannelId, releaseChannelName, branchId?,
 *                                                     branchName?, branchSurfing?: { enabled, pattern },
 *                                                     rollout?: { percentage, rolloutBranchName } }]
 *   POST {app}/channels                          { channelName, branchName? }
 *   PUT  {app}/channels/{channel}/branch-surfing { enabled, pattern }   (an empty pattern is refused)
 *   GET  {app}/branches                          -> [{ branchId, branchName, protected }]
 *        `branchId` can be empty: the dashboard labels such a branch "Legacy".
 *   GET  /api/license                            -> { valid, hasKey, orgName?, validationFailedAt?,
 *                                                     validationErrorCode?, graceEndsAt? }
 *        Branch protection and update health are Enterprise features: without a
 *        valid licence the dashboard shows them locked. How the server words a
 *        refusal is not in the bundle.
 *   POST {app}/branches                          { branchName } -> { branchId }
 *   PUT  {app}/branches/{branch}/protection      { protected }
 *   POST {app}/branch/{branchId}/updateChannelBranchMapping
 *                                                { releaseChannelId, releaseChannelName }
 *        The path segment is the target branch's ID, not its name, and the body
 *        names the channel by both id and name.
 *   GET  {app}/branch/{branch}/runtimeVersions   -> [{ runtimeVersion, numberOfUpdates, lastUpdatedAt }]
 *   GET  {app}/branch/{branch}/runtimeVersion/{rtv}/rollout
 *        -> { active, updates: [{ updateId, controlUpdateId?, platform, percentage, createdAt }] }
 *   PUT  {app}/branch/{branch}/runtimeVersion/{rtv}/rollout
 *        { percentage, expectedUpdateId }        percentage 100 finishes the rollout
 *   POST {app}/branch/{branch}/runtimeVersion/{rtv}/rollout/revert
 *        { expectedUpdateId }                    republishes the previous update as a new one
 *   GET  {app}/branch/{branch}/runtimeVersion/{rtv}/updates/{updateId}
 *        -> { updateId, updateUUID, commitHash, platform, ... }
 *   GET  {app}/identity/update-health?ids={uuid,uuid}
 *        -> { updates: { [updateUUID]: { devicesOnUpdate, successfulDevices, faultyDevices } } }
 *   GET  {app}/observe/update-health/history?ids={uuid,uuid}&from=&to=
 *        -> { source, updates: { [updateUUID]: [{ timestamp, capturedAt, devicesOnUpdate,
 *             successfulDevices, faultyDevices, updateIssues, runtimeIssues }] } }
 *        `updateIssues` is what the dashboard charts as "Native" (launch) issues
 *        and `runtimeIssues` as "JS" issues. `source: "state"` is the degraded
 *        answer of a server without ClickHouse; the dashboard discards it.
 *
 * Two id spaces, and they are not interchangeable:
 *   - `updateId` is the numeric id (`17911745123242`). The rollout endpoints,
 *     `expectedUpdateId`, the update-details path and the upload lease use it.
 *   - `updateUUID` is the content-derived, UUID-shaped id a device reports
 *     (`43d5c1d5-ade8-62d9-1d01-9ffa9a169620`). Health is keyed on it.
 *
 * Ids are kept exactly as the server sent them ({@link XpremId}) and echoed back
 * unchanged, because the bundle does the same and nothing tells us whether the
 * server would accept `"17"` where it sent `17`.
 *
 * Dependency-free, with `.ts` import extensions, on purpose: callers run under
 * bare `node --experimental-strip-types` in jobs that hold the admin login and
 * must not execute a workspace install.
 */

/** An id exactly as the server serialised it. Compare with {@link sameId}, never `===`. */
export type XpremId = string | number;

export interface XpremChannel {
  releaseChannelId: XpremId;
  releaseChannelName: string;
  branchId: XpremId | null;
  branchName: string | null;
  branchSurfing: { enabled: boolean; pattern: string } | null;
  /** A channel-level (branch to branch) rollout. Distinct from a per-update rollout. */
  rollout: { percentage: number; rolloutBranchName: string } | null;
}

export interface XpremBranch {
  /** Null for a "Legacy" branch, which the server lists without an id. */
  branchId: XpremId | null;
  branchName: string;
  protected: boolean;
}

export interface XpremRolloutUpdate {
  updateId: XpremId;
  controlUpdateId: XpremId | null;
  platform: string;
  percentage: number;
  createdAt: string | null;
}

export interface XpremRollout {
  active: boolean;
  updates: XpremRolloutUpdate[];
}

export interface XpremUpdateDetails {
  updateId: XpremId;
  updateUUID: string | null;
  commitHash: string | null;
  platform: string | null;
}

/** Device counts for one update, as `identity/update-health` reports them now. */
export interface XpremUpdateHealth {
  devicesOnUpdate: number;
  successfulDevices: number;
  faultyDevices: number;
}

/** The newest point of one update's health history. */
export interface XpremUpdateIssues {
  timestamp: string;
  /** Launch (native) issues, as the dashboard labels them. */
  updateIssues: number;
  /** JS issues, as the dashboard labels them. */
  runtimeIssues: number;
}

export interface XpremHealthHistory {
  source: string | null;
  latest: Record<string, XpremUpdateIssues>;
}

export interface XpremLicense {
  /** True when Enterprise features (branch protection, update health) are unlocked. */
  valid: boolean;
  hasKey: boolean;
  /** Set when the last validation against the licence server failed. */
  validationErrorCode: string | null;
}

/**
 * Strings that must appear in the dashboard bundle for this client to still be
 * talking to the API the dashboard talks to: one per endpoint or payload key
 * used below. Checked against the live bundle by scripts/ota-admin-api-probe.ts.
 *
 * They are fragments of the bundle's own template literals, so each is written
 * the way the minified source spells it.
 */
export const XPREM_BUNDLE_MARKERS: readonly { marker: string; usedFor: string }[] = [
  { marker: '"/auth/login"', usedFor: 'admin login' },
  { marker: '"/api/license"', usedFor: 'licence read' },
  { marker: '`/api/apps/${encodeURIComponent(this.appId)}`', usedFor: 'app scope' },
  { marker: '}/channels`', usedFor: 'list and create channels' },
  { marker: '/branch-surfing`', usedFor: 'set Branch Surfing' },
  { marker: '}/branches`', usedFor: 'list and create branches' },
  { marker: '/protection`', usedFor: 'protect a branch' },
  { marker: '/updateChannelBranchMapping`', usedFor: 'map a channel to a branch' },
  { marker: '/runtimeVersions`', usedFor: 'list runtime versions' },
  { marker: '/rollout`', usedFor: 'read and set a rollout' },
  { marker: '/rollout/revert`', usedFor: 'revert a rollout' },
  { marker: '/updates/${encodeURIComponent(', usedFor: 'update details' },
  { marker: '/identity/update-health?ids=', usedFor: 'update health' },
  { marker: '/observe/update-health/history?', usedFor: 'update health history' },
  { marker: 'expectedUpdateId', usedFor: 'rollout write payload' },
  { marker: 'releaseChannelId', usedFor: 'channel mapping payload' },
  { marker: 'branchName:', usedFor: 'create-branch payload' },
  { marker: 'protected:', usedFor: 'protection payload' },
];

/** The markers a bundle no longer contains. Empty means the API is where this client expects it. */
export function missingBundleMarkers(bundleSource: string): { marker: string; usedFor: string }[] {
  return XPREM_BUNDLE_MARKERS.filter(({ marker }) => !bundleSource.includes(marker));
}

/** How long one request may take before it is abandoned. The server answers in well under a second. */
const REQUEST_TIMEOUT_MS = 30_000;

/** A non-2xx answer from the server. `status` is what callers branch on (409 = live rollout). */
export class XpremApiError extends Error {
  status: number;

  constructor(action: string, status: number, detail: string) {
    super(`${action} failed (HTTP ${status})${detail ? `: ${detail}` : ''}`);
    this.name = 'XpremApiError';
    this.status = status;
  }
}

export function sameId(left: XpremId, right: XpremId): boolean {
  return String(left) === String(right);
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`xprem ${label} is not an object.`);
  }
  return input as Record<string, unknown>;
}

function list(input: unknown, label: string): unknown[] {
  if (!Array.isArray(input)) throw new Error(`xprem ${label} is not a list.`);
  return input;
}

function text(input: unknown, label: string): string {
  if (typeof input !== 'string' || input === '') throw new Error(`xprem ${label} is not a non-empty string.`);
  return input;
}

function optionalText(input: unknown): string | null {
  return typeof input === 'string' && input !== '' ? input : null;
}

function count(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
    throw new Error(`xprem ${label} is not a non-negative number.`);
  }
  return input;
}

function id(input: unknown, label: string): XpremId {
  if (typeof input === 'number' && Number.isSafeInteger(input)) return input;
  if (typeof input === 'string' && input !== '') return input;
  throw new Error(`xprem ${label} is not an id.`);
}

function optionalId(input: unknown): XpremId | null {
  if (typeof input === 'number' && Number.isSafeInteger(input)) return input;
  return typeof input === 'string' && input !== '' ? input : null;
}

function parseChannel(input: unknown): XpremChannel {
  const raw = record(input, 'channel');
  const surfing = raw.branchSurfing == null ? null : record(raw.branchSurfing, 'channel branchSurfing');
  const rollout = raw.rollout == null ? null : record(raw.rollout, 'channel rollout');
  return {
    releaseChannelId: id(raw.releaseChannelId, 'channel releaseChannelId'),
    releaseChannelName: text(raw.releaseChannelName, 'channel releaseChannelName'),
    branchId: optionalId(raw.branchId),
    branchName: optionalText(raw.branchName),
    branchSurfing: surfing && {
      enabled: surfing.enabled === true,
      pattern: typeof surfing.pattern === 'string' ? surfing.pattern : '',
    },
    rollout: rollout && {
      percentage: count(rollout.percentage, 'channel rollout percentage'),
      rolloutBranchName: text(rollout.rolloutBranchName, 'channel rollout rolloutBranchName'),
    },
  };
}

function parseBranch(input: unknown): XpremBranch {
  const raw = record(input, 'branch');
  return {
    branchId: optionalId(raw.branchId),
    branchName: text(raw.branchName, 'branch branchName'),
    protected: raw.protected === true,
  };
}

function parseRollout(input: unknown): XpremRollout {
  const raw = record(input, 'rollout');
  if (typeof raw.active !== 'boolean') throw new Error('xprem rollout has no boolean `active`.');
  // The dashboard reads `updates` only when `active` is true, so an inactive
  // answer is allowed to omit it.
  const updates = raw.active ? list(raw.updates, 'rollout updates') : [];
  return {
    active: raw.active,
    updates: updates.map((entry): XpremRolloutUpdate => {
      const update = record(entry, 'rollout update');
      return {
        updateId: id(update.updateId, 'rollout updateId'),
        controlUpdateId: optionalId(update.controlUpdateId),
        platform: text(update.platform, 'rollout platform'),
        percentage: count(update.percentage, 'rollout percentage'),
        createdAt: optionalText(update.createdAt),
      };
    }),
  };
}

function parseHealth(input: unknown, label: string): XpremUpdateHealth {
  const raw = record(input, label);
  return {
    devicesOnUpdate: count(raw.devicesOnUpdate, `${label} devicesOnUpdate`),
    successfulDevices: count(raw.successfulDevices, `${label} successfulDevices`),
    faultyDevices: count(raw.faultyDevices, `${label} faultyDevices`),
  };
}

export interface AdminLoginOptions {
  baseUrl: string;
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
}

/** `POST /auth/login`, the dashboard's own sign-in. Returns the session JWT. */
export async function adminLogin(options: AdminLoginOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: options.email, password: options.password }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Admin login failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
  }
  const payload = (await response.json()) as { token?: unknown };
  if (typeof payload.token !== 'string' || payload.token === '') throw new Error('Admin login returned no token.');
  return payload.token;
}

/** The server origin, from the manifest URL the publish tooling is configured with. */
export function adminBaseUrl(configuredUrl: string): string {
  return configuredUrl.replace(/\/manifest\/?$/, '').replace(/\/+$/, '');
}

export interface XpremAdminClientOptions {
  baseUrl: string;
  appId: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export type XpremAdminClient = ReturnType<typeof createXpremAdminClient>;

export function createXpremAdminClient(options: XpremAdminClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const app = `/api/apps/${encodeURIComponent(options.appId)}`;
  const segment = (value: XpremId): string => encodeURIComponent(String(value));
  const rolloutPath = (branch: string, runtimeVersion: string): string =>
    `${app}/branch/${segment(branch)}/runtimeVersion/${segment(runtimeVersion)}/rollout`;

  async function request(action: string, method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetchImpl(`${options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new XpremApiError(action, response.status, (await response.text()).slice(0, 300));
    }
    if (response.status === 204) return null;
    const responseText = await response.text();
    return responseText === '' ? null : (JSON.parse(responseText) as unknown);
  }

  return {
    /** The server's licence state. Not app-scoped. */
    async getLicense(): Promise<XpremLicense> {
      const raw = record(await request('Read licence', 'GET', '/api/license'), 'licence');
      return {
        valid: raw.valid === true,
        hasKey: raw.hasKey === true,
        validationErrorCode: optionalText(raw.validationErrorCode),
      };
    },

    async getChannels(): Promise<XpremChannel[]> {
      return list(await request('List channels', 'GET', `${app}/channels`), 'channel list').map(parseChannel);
    },

    async createChannel(channelName: string, branchName: string): Promise<void> {
      await request(`Create channel "${channelName}"`, 'POST', `${app}/channels`, { channelName, branchName });
    },

    async setChannelBranchSurfing(channelName: string, enabled: boolean, pattern: string): Promise<void> {
      await request(
        `Set branch surfing on "${channelName}"`,
        'PUT',
        `${app}/channels/${segment(channelName)}/branch-surfing`,
        { enabled, pattern },
      );
    },

    async getBranches(): Promise<XpremBranch[]> {
      return list(await request('List branches', 'GET', `${app}/branches`), 'branch list').map(parseBranch);
    },

    async createBranch(branchName: string): Promise<XpremId> {
      const created = record(
        await request(`Create branch "${branchName}"`, 'POST', `${app}/branches`, { branchName }),
        'created branch',
      );
      return id(created.branchId, 'created branch branchId');
    },

    async setBranchProtection(branchName: string, isProtected: boolean): Promise<void> {
      await request(
        `Set protection on branch "${branchName}"`,
        'PUT',
        `${app}/branches/${segment(branchName)}/protection`,
        { protected: isProtected },
      );
    },

    /** Point a channel at a branch. Addressed by the target branch's id. */
    async mapChannelToBranch(
      channel: Pick<XpremChannel, 'releaseChannelId' | 'releaseChannelName'>,
      branchId: XpremId,
    ): Promise<void> {
      await request(
        `Map channel "${channel.releaseChannelName}"`,
        'POST',
        `${app}/branch/${segment(branchId)}/updateChannelBranchMapping`,
        { releaseChannelId: channel.releaseChannelId, releaseChannelName: channel.releaseChannelName },
      );
    },

    async getRuntimeVersions(branch: string): Promise<string[]> {
      const path = `${app}/branch/${segment(branch)}/runtimeVersions`;
      return list(await request(`List runtime versions of "${branch}"`, 'GET', path), 'runtime version list').map(
        (entry) => text(record(entry, 'runtime version').runtimeVersion, 'runtimeVersion'),
      );
    },

    async getUpdateRollout(branch: string, runtimeVersion: string): Promise<XpremRollout> {
      return parseRollout(await request('Read rollout', 'GET', rolloutPath(branch, runtimeVersion)));
    },

    /** Raise a rollout. `percentage: 100` finishes it. */
    async setUpdateRolloutPercentage(
      branch: string,
      runtimeVersion: string,
      percentage: number,
      expectedUpdateId: XpremId,
    ): Promise<void> {
      await request('Set rollout percentage', 'PUT', rolloutPath(branch, runtimeVersion), {
        percentage,
        expectedUpdateId,
      });
    },

    async revertUpdateRollout(branch: string, runtimeVersion: string, expectedUpdateId: XpremId): Promise<void> {
      await request('Revert rollout', 'POST', `${rolloutPath(branch, runtimeVersion)}/revert`, { expectedUpdateId });
    },

    async getUpdateDetails(branch: string, runtimeVersion: string, updateId: XpremId): Promise<XpremUpdateDetails> {
      const path = `${app}/branch/${segment(branch)}/runtimeVersion/${segment(runtimeVersion)}/updates/${segment(updateId)}`;
      const raw = record(await request('Read update details', 'GET', path), 'update details');
      return {
        updateId: optionalId(raw.updateId) ?? updateId,
        updateUUID: optionalText(raw.updateUUID),
        commitHash: optionalText(raw.commitHash),
        platform: optionalText(raw.platform),
      };
    },

    /** Current device counts per update UUID. An update the server has no row for is absent. */
    async getUpdateHealth(updateUUIDs: readonly string[]): Promise<Record<string, XpremUpdateHealth>> {
      const path = `${app}/identity/update-health?ids=${encodeURIComponent(updateUUIDs.join(','))}`;
      const raw = record(await request('Read update health', 'GET', path), 'update health');
      const updates = record(raw.updates ?? {}, 'update health updates');
      return Object.fromEntries(
        Object.entries(updates).map(([updateUUID, entry]) => [updateUUID, parseHealth(entry, 'update health entry')]),
      );
    },

    /** The newest history point per update UUID, which carries the launch and JS issue counts. */
    async getUpdateHealthHistory(updateUUIDs: readonly string[]): Promise<XpremHealthHistory> {
      const query = new URLSearchParams({ ids: updateUUIDs.join(',') });
      const path = `${app}/observe/update-health/history?${query.toString()}`;
      const raw = record(await request('Read update health history', 'GET', path), 'update health history');
      const updates = record(raw.updates ?? {}, 'update health history updates');
      const latest: Record<string, XpremUpdateIssues> = {};
      for (const [updateUUID, pointsInput] of Object.entries(updates)) {
        const points = list(pointsInput, 'update health history points').map((pointInput) => {
          const point = record(pointInput, 'update health history point');
          return {
            timestamp: text(point.timestamp, 'history point timestamp'),
            updateIssues: count(point.updateIssues, 'history point updateIssues'),
            runtimeIssues: count(point.runtimeIssues, 'history point runtimeIssues'),
          };
        });
        const newest = points.sort((left, right) => left.timestamp.localeCompare(right.timestamp)).at(-1);
        if (newest) latest[updateUUID] = newest;
      }
      return { source: optionalText(raw.source), latest };
    },
  };
}

export interface AdminEnvironment {
  OTA_BASE_URL?: string;
  EXPO_UPDATES_URL?: string;
  OTA_ADMIN_EMAIL?: string;
  OTA_ADMIN_PASSWORD?: string;
}

/**
 * Sign in with `OTA_ADMIN_EMAIL` / `OTA_ADMIN_PASSWORD` and return a client for
 * one app. The server is `OTA_BASE_URL`, else `EXPO_UPDATES_URL`, else the
 * declared default.
 */
export async function adminClientFromEnvironment(options: {
  appId: string;
  defaultBaseUrl: string;
  environment: AdminEnvironment;
  fetchImpl?: typeof fetch;
}): Promise<XpremAdminClient> {
  const { environment } = options;
  const email = environment.OTA_ADMIN_EMAIL;
  const password = environment.OTA_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set OTA_ADMIN_EMAIL and OTA_ADMIN_PASSWORD.');
  const baseUrl = adminBaseUrl(environment.OTA_BASE_URL || environment.EXPO_UPDATES_URL || options.defaultBaseUrl);
  const token = await adminLogin({ baseUrl, email, password, fetchImpl: options.fetchImpl });
  return createXpremAdminClient({ baseUrl, appId: options.appId, token, fetchImpl: options.fetchImpl });
}

/** Run `task` over `items` with at most `limit` in flight, keeping input order. */
export async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  task: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
