/// <reference types="node" />

import { createHash } from 'node:crypto';
import { FAKE_BASE_URL, fakeXprem } from './fake-xprem';
import type { FakeAnswer, FakeRoute, RecordedRequest } from './fake-xprem';

/**
 * A stateful stand-in for the parts of xprem 3.2.5 a rollout touches: publish
 * (lease, upload, finalize), republish and rollback, the rollout read and its
 * two writes, the update list, health, and the manifest a device is served.
 *
 * It is built on {@link fakeXprem}, whose route table is a lookup by
 * `"METHOD /path"`. Here every lookup is answered by one handler that keeps
 * state, so a sequence of calls behaves like a server and not like a script.
 *
 * The rules are the ones read out of the server's source at the v3.2.5 tag
 * (internal/services/deployment_service.go, rollout_service.go,
 * internal/rollout/bucketing.go and the rollout handler):
 *   - the publish lock is per branch and runtime version, across platforms;
 *   - a rollout row is per platform, and both writes act on every active row;
 *   - `expectedUpdateId` is decoded as a string, so a number is a 400 and a
 *     wrong string a 409;
 *   - a request with no `EAS-Client-ID` is never in a rollout;
 *   - revert republishes each control as a new update with an empty commit.
 * A test of the proof against this proves the proof's own logic. Whether the
 * live server follows the same rules is what the proof exists to find out.
 */

export interface RolloutServerQuirks {
  /** The publish lock does not hold: a lease is handed out while a rollout is live. */
  leaseDuringRollout?: boolean;
  /** Branch Surfing does not serve the branch: every manifest is "no update". */
  surfingOff?: boolean;
  /** Every publish request is refused with this status. */
  refusePublishWith?: number;
  /** The status a rollout write with a wrong `expectedUpdateId` gets, in place of 409. */
  wrongExpectedIdStatus?: number;
  /** Republish and rollback are refused with this status: a publish token limited to publishing. */
  refuseRepublishWith?: number;
  /** What the update list answers, in place of the real list. */
  updateListAnswer?: FakeAnswer;
  /** What both health endpoints answer, in place of an empty result. */
  healthAnswer?: FakeAnswer;
  /** The channel list the server reports. Defaults to `production` serving `production`. */
  channels?: unknown[];
}

interface UpdateRow {
  id: number;
  uuid: string;
  platform: string;
  bundleHash: string;
  commitHash: string;
  message: string;
  checked: boolean;
  rolloutPercentage: number | null;
  controlUpdateId: number | null;
  createdAt: string;
}

const PROBLEM = (status: number, detail: string): FakeAnswer => ({ status, body: { status, detail } });

function uuidShaped(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The server's bucketing: a salted hash of the client id, as a position in [0, 1). */
function inBucket(clientId: string | undefined, updateId: number, percentage: number): boolean {
  if (!clientId) return false;
  const digest = createHash('sha256').update(`${clientId}:update:${updateId}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32 < percentage / 100;
}

export function fakeRolloutServer(quirks: RolloutServerQuirks = {}): ReturnType<typeof fakeXprem> {
  const rows: UpdateRow[] = [];
  let nextId = 1_790_000_000_000;

  const active = (): UpdateRow[] =>
    rows
      .filter((row) => row.checked && row.rolloutPercentage !== null)
      .sort((left, right) => left.platform.localeCompare(right.platform));
  const newestChecked = (platform: string): UpdateRow | undefined =>
    rows.filter((row) => row.checked && row.platform === platform).sort((left, right) => right.id - left.id)[0];
  const insert = (row: Omit<UpdateRow, 'id' | 'uuid' | 'createdAt'>): UpdateRow => {
    const id = nextId++;
    const created: UpdateRow = { ...row, id, uuid: uuidShaped(`update-${id}`), createdAt: '2026-10-05T10:00:00.000Z' };
    rows.push(created);
    return created;
  };

  /** The guard both rollout writes share. Null when the write may proceed. */
  const refusedWrite = (body: unknown): FakeAnswer | null => {
    const expected = (body as { expectedUpdateId?: unknown } | null)?.expectedUpdateId;
    if (expected !== undefined && typeof expected !== 'string') return PROBLEM(400, 'invalid request body');
    if (active().length === 0) return PROBLEM(404, 'no active rollout for this branch and runtime version');
    if (expected !== undefined && !active().some((row) => String(row.id) === expected)) {
      return PROBLEM(
        quirks.wrongExpectedIdStatus ?? 409,
        'the rollout changed since this page was loaded; reload and retry',
      );
    }
    return null;
  };

  const handle = (request: RecordedRequest): FakeAnswer => {
    const url = new URL(`${FAKE_BASE_URL}${request.path}`);
    const path = url.pathname;
    const { method } = request;

    if (method === 'POST' && path === '/auth/login') return { token: 'session-jwt', refreshToken: 'refresh-jwt' };
    if (method === 'PUT' && path.startsWith('/upload/')) return { status: 200 };

    if (method === 'GET' && path === '/manifest') {
      const platform = request.headers['expo-platform'];
      const head = newestChecked(platform);
      if (quirks.surfingOff || !head) return { type: 'noUpdateAvailable' };
      const control = rows.find((row) => row.id === head.controlUpdateId);
      const servesCanary =
        head.rolloutPercentage === null || inBucket(request.headers['eas-client-id'], head.id, head.rolloutPercentage);
      const served = servesCanary ? head : control;
      if (!served) return { type: 'noUpdateAvailable' };
      return {
        id: served.uuid,
        runtimeVersion: request.headers['expo-runtime-version'],
        launchAsset: { hash: served.bundleHash },
        assets: [],
        extra: { branch: request.headers['xprem-branch'], expoClient: {} },
      };
    }

    const publish = /^\/[^/]+\/(requestUploadUrl|markUpdateAsUploaded|republish|rollback)\/[^/]+$/.exec(path);
    if (method === 'POST' && publish) {
      if (quirks.refusePublishWith) return { status: quirks.refusePublishWith, body: 'refused' };
      if (quirks.refuseRepublishWith && (publish[1] === 'republish' || publish[1] === 'rollback')) {
        return { status: quirks.refuseRepublishWith, body: 'This API key cannot roll back this branch' };
      }
      const action = publish[1];
      const platform = url.searchParams.get('platform') ?? '';
      if (action === 'markUpdateAsUploaded') {
        const row = rows.find((candidate) => String(candidate.id) === url.searchParams.get('updateId'));
        if (!row) return { status: 400, body: 'unknown update' };
        row.checked = true;
        return { updateUUID: row.uuid };
      }
      if (active().length > 0 && !(action === 'requestUploadUrl' && quirks.leaseDuringRollout)) {
        return { status: 409, body: 'A progressive rollout is active on this branch.' };
      }
      if (action !== 'requestUploadUrl') return { updates: [] };
      const files = (request.body as { files: { path: string; hash: string; role: string }[]; message?: string }).files;
      const rolloutParam = url.searchParams.get('rolloutPercentage');
      const row = insert({
        platform,
        bundleHash: files.find((file) => file.role === 'launch')?.hash ?? '',
        commitHash: url.searchParams.get('commitHash') ?? '',
        message: (request.body as { message?: string }).message ?? '',
        checked: false,
        rolloutPercentage: rolloutParam === null ? null : Number(rolloutParam),
        controlUpdateId: rolloutParam === null ? null : (newestChecked(platform)?.id ?? null),
      });
      return {
        updateId: row.id,
        uploadRequests: files.map((file) => ({
          requestUploadUrl: `https://bucket.example/upload/${row.id}/${file.path}?X-Amz-Signature=SIGNATURE-SECRET`,
          fileName: file.path.split('/').pop(),
          filePath: file.path,
        })),
        ...(rolloutParam === null ? {} : { rolloutPercentage: Number(rolloutParam) }),
        publishGroup: url.searchParams.get('publishGroup'),
      };
    }

    const admin = /^\/api\/apps\/[^/]+\/(.+)$/.exec(path);
    if (!admin) throw new Error(`Unexpected request: ${method} ${request.path}`);
    const resource = admin[1];
    if (method === 'GET' && resource === 'channels') {
      return (
        quirks.channels ?? [
          {
            releaseChannelId: 1,
            releaseChannelName: 'production',
            branchId: 1,
            branchName: 'production',
            branchSurfing: { enabled: true, pattern: 'pr-*' },
          },
        ]
      );
    }
    if (method === 'GET' && resource === 'branches') {
      return [{ branchId: 1, branchName: 'production', protected: true }];
    }
    if (method === 'GET' && resource === 'identity/update-health') return quirks.healthAnswer ?? { updates: {} };
    if (method === 'GET' && resource === 'observe/update-health/history') {
      return quirks.healthAnswer ?? { source: 'clickhouse', updates: {} };
    }

    const scoped = /^branch\/[^/]+\/runtimeVersion\/[^/]+\/(.+)$/.exec(resource);
    if (!scoped) throw new Error(`Unexpected request: ${method} ${request.path}`);
    const call = scoped[1];
    if (method === 'GET' && call === 'rollout') {
      return {
        active: active().length > 0,
        updates: active().map((row) => ({
          updateId: String(row.id),
          platform: row.platform,
          percentage: row.rolloutPercentage,
          ...(row.controlUpdateId === null ? {} : { controlUpdateId: String(row.controlUpdateId) }),
          createdAt: row.createdAt,
        })),
      };
    }
    if (method === 'PUT' && call === 'rollout') {
      const refusal = refusedWrite(request.body);
      if (refusal) return refusal;
      const { percentage } = request.body as { percentage: number };
      if (percentage !== 100 && active().some((row) => (row.rolloutPercentage ?? 0) >= percentage)) {
        return PROBLEM(400, 'the rollout percentage can only increase');
      }
      for (const row of active()) row.rolloutPercentage = percentage === 100 ? null : percentage;
      return { status: 204 };
    }
    if (method === 'POST' && call === 'rollout/revert') {
      const refusal = refusedWrite(request.body);
      if (refusal) return refusal;
      for (const row of active()) {
        row.rolloutPercentage = null;
        const control = rows.find((candidate) => candidate.id === row.controlUpdateId);
        if (!control) continue;
        insert({
          ...control,
          commitHash: '',
          message: '',
          checked: true,
          rolloutPercentage: null,
          controlUpdateId: null,
        });
      }
      return { status: 204 };
    }
    if (method === 'GET' && call === 'updates' && quirks.updateListAnswer) return quirks.updateListAnswer;
    if (method === 'GET' && call === 'updates') {
      return {
        items: rows
          .filter((row) => row.checked)
          .sort((left, right) => right.id - left.id)
          .map((row) => ({
            updateUUID: row.uuid,
            updateId: String(row.id),
            createdAt: row.createdAt,
            commitHash: row.commitHash,
            platform: row.platform,
            ...(row.message ? { message: row.message } : {}),
            ...(row.rolloutPercentage === null ? {} : { rolloutPercentage: row.rolloutPercentage }),
            ...(row.controlUpdateId === null ? {} : { controlUpdateId: String(row.controlUpdateId) }),
          })),
        nextCursor: null,
      };
    }
    const details = /^updates\/(\d+)$/.exec(call);
    if (method === 'GET' && details) {
      const row = rows.find((candidate) => String(candidate.id) === details[1]);
      if (!row) return PROBLEM(404, 'No update found');
      return { updateId: String(row.id), updateUUID: row.uuid, commitHash: row.commitHash, platform: row.platform };
    }
    throw new Error(`Unexpected request: ${method} ${request.path}`);
  };

  // fakeXprem looks a route up by its exact "METHOD /path" key. Answering every
  // key with the stateful handler keeps its recording and its Response handling.
  const routes = new Proxy<Record<string, FakeRoute>>({}, { get: () => handle });
  return fakeXprem(routes);
}
