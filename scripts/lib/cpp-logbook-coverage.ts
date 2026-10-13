import { createHash } from 'node:crypto';
import { GET_USER_GROUPED_ASCENTS_FEED } from '../../packages/shared/graphql/src/operations/ticks';
import {
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  filtersForStatusSegment,
  pickBestGroupEntry,
  toAscentFeedInput,
} from '../../packages/shared/logbook/src';
import { isCppAscentId, readCppPage } from './screenshot-cpp';
import {
  canonicalJson,
  graphqlFixtureKey,
  findSensitiveVariableKeys,
  findUnpseudonymisedPersonFields,
  REDACTED_PER_RUN_VALUE,
  normalizeDocument,
  type GraphqlFixtureFile,
  type ScreenshotFixtureManifest,
} from './screenshot-fixtures';

const sha256 = (contents: string) => createHash('sha256').update(contents).digest('hex');
const object = (contents: unknown): contents is Record<string, unknown> =>
  typeof contents === 'object' && contents !== null && !Array.isArray(contents);
const fail = (): never => {
  throw new Error('CPP MoonBoard logbook lacks the unchanged genuine primary attempt');
};

export interface CppLogbookRead {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
  documentHash: string;
  variablesHash: string;
}
export interface CppLogbookAttemptsProof {
  target: 'moonboard';
  ascentId: string;
  variablesHash: string;
  responseSha256: string;
}

function request(manifest: ScreenshotFixtureManifest, attempts: boolean): CppLogbookRead {
  const nativeInput = toAscentFeedInput({
    filters: { ...DEFAULT_LOGBOOK_FILTERS, ...(attempts ? filtersForStatusSegment('attempts') : {}) },
    sort: DEFAULT_LOGBOOK_SORT,
    boardTypes: ['moonboard'],
    now: new Date(manifest.frozenNow),
  });
  const input = { ...nativeInput, limit: 20, offset: 0 };
  // This preparer permits one known native request, never arbitrary filters or pagination.
  if (
    canonicalJson(input) !==
    canonicalJson({
      boardType: 'moonboard',
      statusMode: attempts ? 'attempt' : 'both',
      flashOnly: false,
      sortBy: 'recent',
      sortOrder: 'desc',
      limit: 20,
      offset: 0,
    })
  )
    fail();
  const expected = {
    operationName: 'GetUserGroupedAscentsFeed',
    query: GET_USER_GROUPED_ASCENTS_FEED,
    variables: { userId: manifest.accountUserId, input },
  };
  return { ...expected, ...graphqlFixtureKey(expected, sha256) };
}

function groups(fixture: GraphqlFixtureFile): Record<string, unknown>[] {
  const response = fixture.response;
  if (!object(response) || response.errors !== undefined || !object(response.data)) return fail();
  const feed = response.data.userGroupedAscentsFeed;
  if (
    !object(feed) ||
    !Array.isArray(feed.groups) ||
    feed.groups.length > 20 ||
    !Number.isSafeInteger(feed.totalCount) ||
    Number(feed.totalCount) < feed.groups.length ||
    typeof feed.hasMore !== 'boolean' ||
    feed.hasMore !== Number(feed.totalCount) > feed.groups.length
  )
    return fail();
  const seen = new Set<string>();
  for (const group of feed.groups) {
    if (
      !object(group) ||
      typeof group.key !== 'string' ||
      !group.key ||
      seen.has(group.key) ||
      group.boardType !== 'moonboard' ||
      !Array.isArray(group.items) ||
      !group.items.length ||
      group.items.some((item) => !object(item))
    )
      return fail();
    seen.add(group.key);
  }
  return feed.groups as Record<string, unknown>[];
}

function containsCredential(contents: unknown): boolean {
  if (findSensitiveVariableKeys(contents).length) return true;
  if (Array.isArray(contents)) return contents.some(containsCredential);
  return (
    object(contents) &&
    Object.entries(contents).some(
      ([key, field]) =>
        (/^(jwt|(?:access|refresh|auth|id|bearer)[_-]?tokens?)$/i.test(key) && field !== REDACTED_PER_RUN_VALUE) ||
        containsCredential(field),
    )
  );
}

function assertRequest(
  manifest: ScreenshotFixtureManifest,
  fixture: GraphqlFixtureFile,
  expected: CppLogbookRead,
): void {
  const key = graphqlFixtureKey(fixture, sha256);
  const entries = manifest.graphql.filter(
    (entry) => entry.operationName === expected.operationName && entry.variablesHash === expected.variablesHash,
  );
  if (
    containsCredential(fixture.response) ||
    findSensitiveVariableKeys(fixture.variables).length ||
    findUnpseudonymisedPersonFields(fixture.response, {
      ownUserId: manifest.accountUserId,
      approvedTestUserIds: manifest.approvedTestUserIds,
    }).length ||
    fixture.formatVersion !== 1 ||
    fixture.status !== 200 ||
    fixture.upstream !== manifest.upstream ||
    !Number.isFinite(Date.parse(fixture.recordedAt)) ||
    Date.parse(fixture.recordedAt) > Date.parse(manifest.frozenNow) ||
    fixture.operationName !== expected.operationName ||
    normalizeDocument(fixture.query) !== normalizeDocument(expected.query) ||
    canonicalJson(fixture.variables) !== canonicalJson(expected.variables) ||
    key.documentHash !== expected.documentHash ||
    key.variablesHash !== expected.variablesHash ||
    fixture.documentHash !== key.documentHash ||
    fixture.variablesHash !== key.variablesHash ||
    entries.length !== 1 ||
    entries[0].documentHash !== key.documentHash ||
    entries[0].file !== `graphql/${key.operationName}/${key.variablesHash.slice(0, 16)}.json`
  )
    fail();
}

function primary(manifest: ScreenshotFixtureManifest, fixture: GraphqlFixtureFile): Record<string, unknown> {
  const coverage = manifest.capture?.cpp;
  const scene = coverage?.scenes.logbook;
  const board = readCppPage('moonboard').primaryBoard;
  if (
    manifest.flow !== 'app-store-cpp' ||
    coverage?.target !== 'moonboard' ||
    !isCppAscentId(manifest.accountUserId) ||
    !scene ||
    !isCppAscentId(scene.ascentId) ||
    scene.boardId !== coverage.boardIds?.[board.id]
  )
    return fail();
  const items = groups(fixture).flatMap((group) => group.items as Record<string, unknown>[]);
  const seen = new Set<string>();
  for (const item of items) {
    if (!isCppAscentId(item.uuid) || seen.has(item.uuid) || item.boardType !== 'moonboard') return fail();
    seen.add(item.uuid);
  }
  const matches = items.filter((item) => item.uuid === scene.ascentId);
  const ascent = matches[0];
  if (
    matches.length !== 1 ||
    ascent.status !== 'attempt' ||
    ascent.climbName !== scene.readyText ||
    !isCppAscentId(ascent.climbUuid) ||
    ascent.layoutId !== board.layoutId ||
    ascent.angle !== board.angle ||
    !object(ascent.renderBoard) ||
    ascent.renderBoard.layoutId !== board.layoutId ||
    ascent.renderBoard.sizeId !== board.sizeId ||
    canonicalJson(ascent.renderBoard.setIds) !== canonicalJson(board.setIds) ||
    typeof ascent.frames !== 'string' ||
    !ascent.frames ||
    typeof ascent.climbedAt !== 'string' ||
    !Number.isFinite(Date.parse(ascent.climbedAt))
  )
    return fail();
  return ascent;
}

/** One exact scene read; original native recordings need not already contain the filtered page. */
export function resolveCppLogbookRead(
  manifest: ScreenshotFixtureManifest,
  fixtures: readonly GraphqlFixtureFile[],
): CppLogbookRead | undefined {
  if (manifest.capture?.cpp?.target !== 'moonboard') return undefined;
  const original = request(manifest, false);
  const matches = fixtures.filter(
    (fixture) => fixture.operationName === original.operationName && fixture.variablesHash === original.variablesHash,
  );
  if (matches.length !== 1) return fail();
  assertRequest(manifest, matches[0], original);
  primary(manifest, matches[0]);
  return request(manifest, true);
}

/** Native captures launch with SIMCTL_CHILD_TZ=UTC; never inherit the preparer's timezone. */
function captureDayKey(climbedAt: string): string {
  const timestamp = climbedAt.replace(' ', 'T');
  const instant = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp) ? timestamp : `${timestamp}Z`);
  if (!Number.isFinite(instant.getTime())) return fail();
  return instant.toISOString().slice(0, 10);
}

/** The recorder supplies the whole server page. No rows, counters or comments are synthesized. */
export function assertCppLogbookResponse(
  manifest: ScreenshotFixtureManifest,
  fixtures: readonly GraphqlFixtureFile[],
  fixture: GraphqlFixtureFile,
): CppLogbookAttemptsProof {
  const expected = resolveCppLogbookRead(manifest, fixtures);
  if (!expected) return fail();
  assertRequest(manifest, fixture, expected);
  const original = request(manifest, false);
  const originalFixture = fixtures.find(
    (entry) => entry.operationName === original.operationName && entry.variablesHash === original.variablesHash,
  )!;
  const originalPrimary = primary(manifest, originalFixture);
  const filteredPrimary = primary(manifest, fixture);
  if (canonicalJson(originalPrimary) !== canonicalJson(filteredPrimary)) return fail();
  const filteredGroups = groups(fixture);
  for (const group of filteredGroups) {
    const items = group.items as Record<string, unknown>[];
    if (
      items.some(
        (item) =>
          item.status !== 'attempt' ||
          !isCppAscentId(item.climbUuid) ||
          typeof item.angle !== 'number' ||
          !Number.isFinite(item.angle) ||
          typeof item.isMirror !== 'boolean' ||
          item.climbUuid !== group.climbUuid ||
          item.layoutId !== group.layoutId ||
          !Number.isSafeInteger(item.attemptCount) ||
          Number(item.attemptCount) < 0 ||
          typeof item.climbedAt !== 'string' ||
          !Number.isFinite(Date.parse(item.climbedAt)) ||
          (item.difficulty !== null && (typeof item.difficulty !== 'number' || !Number.isFinite(item.difficulty))),
      ) ||
      group.flashCount !== 0 ||
      group.sendCount !== 0 ||
      group.attemptCount !== items.length
    )
      return fail();
  }
  // The native list flattens every server group before grouping by local day,
  // climb, angle and mirror. Captures use UTC, even when preparation runs elsewhere.
  const primaryDay = captureDayKey(String(originalPrimary.climbedAt));
  const bucket = filteredGroups
    .flatMap((group) => group.items as Record<string, unknown>[])
    .filter(
      (item) =>
        item.climbUuid === originalPrimary.climbUuid &&
        item.angle === originalPrimary.angle &&
        item.isMirror === originalPrimary.isMirror &&
        captureDayKey(String(item.climbedAt)) === primaryDay,
    )
    .map((item) => ({
      uuid: String(item.uuid),
      status: 'attempt' as const,
      climbedAt: String(item.climbedAt),
      attemptCount: Number(item.attemptCount),
      difficulty: item.difficulty as number | null,
    }));
  if (pickBestGroupEntry(bucket).uuid !== originalPrimary.uuid) return fail();
  return {
    target: 'moonboard',
    ascentId: String(originalPrimary.uuid),
    variablesHash: expected.variablesHash,
    responseSha256: sha256(canonicalJson(fixture.response)),
  };
}

/** Replay must prove the prepared response before selecting Attempts in the native UI. */
export function assertCppLogbookAttemptsReady(
  manifest: ScreenshotFixtureManifest,
  fixtures: readonly GraphqlFixtureFile[],
): CppLogbookAttemptsProof | undefined {
  const expected = resolveCppLogbookRead(manifest, fixtures);
  if (!expected) return undefined;
  const matches = fixtures.filter(
    (fixture) => fixture.operationName === expected.operationName && fixture.variablesHash === expected.variablesHash,
  );
  if (matches.length !== 1) return fail();
  return assertCppLogbookResponse(manifest, fixtures, matches[0]);
}
