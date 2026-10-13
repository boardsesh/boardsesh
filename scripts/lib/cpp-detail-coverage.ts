import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET_MY_BOARDS, SEARCH_CLIMBS } from '../../packages/mobile/src/lib/graphql/operations';
import { GET_BETA_LINKS } from '../../packages/shared/graphql/src/operations/beta-links';
import { GET_CLIMB_PROPOSALS } from '../../packages/shared/graphql/src/operations/proposals';
import { CLIMB_STATS_HISTORY } from '../../packages/shared/graphql/src/operations/climb-stats-history';
import { CONFIRM_CLIMB_ON_WALL } from '../../packages/shared/graphql/src/operations/queue-session';
import { CPP_BOOTSTRAP_PROFILE_QUERY, createTransport, resolveBootstrapUpstream } from '../bootstrap-cpp-scenario';
import { createScreenshotBackend, readScreenshotFixtureManifest } from './screenshot-backend';
import { isCppClimbId, isCppTarget, readCppPage, type CppBoard } from './screenshot-cpp';
import { assertCppGradeCountProof } from './cpp-grade-count';
import { isCppWallConfirmation } from './screenshot-campaign-session';
import {
  canonicalJson,
  finalizeRecordingFrozenNow,
  findSensitiveVariableKeys,
  findUnpseudonymisedPersonFields,
  graphqlFixtureKey,
  normalizeDocument,
  REDACTED_PER_RUN_VALUE,
  STATIC_KEY_LENGTH,
  type GraphqlFixtureFile,
  type ScreenshotFixtureManifest,
} from './screenshot-fixtures';

const sha256 = (contents: string | Buffer): string => createHash('sha256').update(contents).digest('hex');
const record = (contents: unknown): contents is Record<string, unknown> =>
  typeof contents === 'object' && contents !== null && !Array.isArray(contents);
const uuid = (contents: unknown): contents is string =>
  typeof contents === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(contents);

export interface CppDetailRead {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
  documentHash: string;
  variablesHash: string;
}

function containsResponseCredentialKey(response: unknown): boolean {
  if (findSensitiveVariableKeys(response).length > 0) return true;
  const walk = (contents: unknown): boolean => {
    if (Array.isArray(contents)) return contents.some(walk);
    if (!record(contents)) return false;
    return Object.entries(contents).some(
      ([key, field]) =>
        (/^(jwt|(?:access|refresh|auth|id|bearer)[_-]?tokens?)$/i.test(key) && field !== REDACTED_PER_RUN_VALUE) ||
        walk(field),
    );
  };
  return walk(response);
}

function assertFixture(manifest: ScreenshotFixtureManifest, fixture: GraphqlFixtureFile): void {
  const key = graphqlFixtureKey(fixture, sha256);
  const entries = manifest.graphql.filter(
    (entry) => entry.operationName === key.operationName && entry.variablesHash === key.variablesHash,
  );
  if (
    fixture.formatVersion !== 1 ||
    fixture.status !== 200 ||
    fixture.upstream !== manifest.upstream ||
    !Number.isFinite(Date.parse(fixture.recordedAt)) ||
    Date.parse(fixture.recordedAt) > Date.parse(manifest.frozenNow) ||
    !record(fixture.response) ||
    !record(fixture.response.data) ||
    fixture.response.errors !== undefined ||
    findSensitiveVariableKeys(fixture.variables).length > 0 ||
    containsResponseCredentialKey(fixture.response) ||
    findUnpseudonymisedPersonFields(fixture.response, {
      ownUserId: manifest.accountUserId,
      approvedTestUserIds: manifest.approvedTestUserIds,
    }).length > 0 ||
    fixture.documentHash !== key.documentHash ||
    fixture.variablesHash !== key.variablesHash ||
    entries.length !== 1 ||
    entries[0].documentHash !== key.documentHash ||
    entries[0].file !== `graphql/${key.operationName}/${key.variablesHash.slice(0, STATIC_KEY_LENGTH)}.json`
  )
    throw new Error('CPP detail source failed canonical response provenance');
}

function fields(fixture: GraphqlFixtureFile, field: string): Record<string, unknown> {
  const response = fixture.response;
  if (!record(response) || !record(response.data) || !record(response.data[field]))
    throw new Error('CPP detail source response has an invalid shape');
  return response.data[field];
}

function sets(contents: unknown): number[] {
  if (typeof contents !== 'string' || !/^\d+(,\d+)*$/.test(contents))
    throw new Error('CPP detail board sets are invalid');
  const ids = contents
    .split(',')
    .map(Number)
    .sort((left, right) => left - right);
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length)
    throw new Error('CPP detail board sets are invalid');
  return ids;
}

function geometry(board: Record<string, unknown>) {
  return {
    boardType: board.boardType ?? board.boardName,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: sets(board.setIds),
    angle: board.angle,
  };
}

function ownedBoard(
  manifest: ScreenshotFixtureManifest,
  fixtures: readonly GraphqlFixtureFile[],
  variant: CppBoard,
): Record<string, unknown> {
  const coverage = manifest.capture!.cpp!;
  const rows = fixtures
    .filter((fixture) => fixture.operationName === 'GetMyBoards')
    .flatMap((fixture) => {
      if (normalizeDocument(fixture.query) !== normalizeDocument(GET_MY_BOARDS))
        throw new Error('CPP detail roster differs from the native document');
      const boards = fields(fixture, 'myBoards').boards;
      if (!Array.isArray(boards) || boards.some((board) => !record(board)))
        throw new Error('CPP detail roster is invalid');
      return boards.filter(record).filter((board) => board.uuid === coverage.boardIds?.[variant.id]);
    });
  const board = rows[0];
  if (
    !board ||
    !uuid(board.uuid) ||
    board.name !== coverage.boardNames?.[variant.id] ||
    board.boardType !== variant.boardType ||
    !Number.isSafeInteger(board.layoutId) ||
    Number(board.layoutId) < 1 ||
    !Number.isSafeInteger(board.sizeId) ||
    Number(board.sizeId) < 1 ||
    typeof board.angle !== 'number' ||
    !Number.isFinite(board.angle) ||
    (variant.layoutId !== undefined && board.layoutId !== variant.layoutId) ||
    (variant.sizeId !== undefined && board.sizeId !== variant.sizeId) ||
    (variant.angle !== undefined && board.angle !== variant.angle) ||
    (variant.setIds !== undefined &&
      canonicalJson(sets(board.setIds)) !== canonicalJson([...variant.setIds].sort((a, b) => a - b))) ||
    rows.some(
      (row) =>
        row.ownerId !== manifest.accountUserId ||
        canonicalJson(geometry(row)) !== canonicalJson(geometry(board)) ||
        row.name !== board.name,
    )
  )
    throw new Error('CPP detail identity lacks a unique recorded owner and geometry');
  return board;
}

function detailReads(boardType: string, climbUuid: string): CppDetailRead[] {
  return [
    { operationName: 'GetBetaLinks', query: GET_BETA_LINKS, variables: { boardType, climbUuid } },
    {
      operationName: 'GetClimbProposals',
      query: GET_CLIMB_PROPOSALS,
      variables: { input: { boardType, climbUuid, limit: 20 } },
    },
    { operationName: 'ClimbStatsHistory', query: CLIMB_STATS_HISTORY, variables: { boardName: boardType, climbUuid } },
  ].map((request) => ({ ...request, ...graphqlFixtureKey(request, sha256) }));
}

function assertDetailResponse(fixture: GraphqlFixtureFile, expected: CppDetailRead): void {
  if (
    normalizeDocument(fixture.query) !== normalizeDocument(expected.query) ||
    fixture.documentHash !== expected.documentHash ||
    canonicalJson(fixture.variables) !== canonicalJson(expected.variables)
  )
    throw new Error('CPP detail fixture collides with the exact native request');
  const response = fixture.response;
  if (!record(response) || !record(response.data) || response.errors !== undefined)
    throw new Error('CPP detail response is invalid');
  const contents = response.data;
  const input = record(expected.variables.input) ? expected.variables.input : expected.variables;
  const climbId = input.climbUuid;
  const boardType = input.boardType ?? input.boardName;
  const nullableString = (field: unknown) => field === null || typeof field === 'string';
  const nullableNumber = (field: unknown) => field === null || (typeof field === 'number' && Number.isFinite(field));
  if (
    (expected.operationName === 'GetBetaLinks' &&
      (!Array.isArray(contents.betaLinks) ||
        contents.betaLinks.some(
          (row) =>
            !record(row) ||
            row.climbUuid !== climbId ||
            typeof row.link !== 'string' ||
            !row.link.trim() ||
            !nullableString(row.foreignUsername) ||
            !nullableString(row.thumbnail) ||
            !nullableString(row.tickUuid) ||
            !nullableNumber(row.angle) ||
            !nullableNumber(row.boardId) ||
            !nullableString(row.createdAt) ||
            (row.isListed !== null && typeof row.isListed !== 'boolean'),
        ))) ||
    (expected.operationName === 'ClimbStatsHistory' &&
      (!Array.isArray(contents.climbStatsHistory) ||
        contents.climbStatsHistory.some(
          (row) =>
            !record(row) ||
            typeof row.angle !== 'number' ||
            !Number.isFinite(row.angle) ||
            !nullableNumber(row.ascensionistCount) ||
            !nullableNumber(row.qualityAverage) ||
            !nullableNumber(row.difficultyAverage) ||
            !nullableNumber(row.displayDifficulty) ||
            typeof row.createdAt !== 'string' ||
            !Number.isFinite(Date.parse(row.createdAt)),
        ))) ||
    (expected.operationName === 'GetClimbProposals' &&
      (!record(contents.climbProposals) ||
        !Array.isArray(contents.climbProposals.proposals) ||
        contents.climbProposals.proposals.some(
          (row) =>
            !record(row) ||
            row.climbUuid !== climbId ||
            row.boardType !== boardType ||
            typeof row.uuid !== 'string' ||
            !row.uuid ||
            (row.proposerId !== null && (typeof row.proposerId !== 'string' || !row.proposerId)) ||
            (row.proposerId === null && (row.proposerDisplayName !== null || row.proposerAvatarUrl !== null)) ||
            !nullableString(row.proposerDisplayName) ||
            !nullableString(row.proposerAvatarUrl),
        ) ||
        !Number.isSafeInteger(contents.climbProposals.totalCount) ||
        Number(contents.climbProposals.totalCount) < 0 ||
        typeof contents.climbProposals.hasMore !== 'boolean'))
  )
    throw new Error('CPP detail response is missing its native collection');
}

/** Only selected, genuine scene climbs can extend a CPP recording. */
export function resolveCppDetailReads(
  manifest: ScreenshotFixtureManifest,
  fixtures: readonly GraphqlFixtureFile[],
): CppDetailRead[] {
  const coverage = manifest.capture?.cpp;
  if (
    manifest.flow !== 'app-store-cpp' ||
    !manifest.accountUserId ||
    !manifest.accountEmail ||
    !Number.isFinite(Date.parse(manifest.recordedAt)) ||
    Date.parse(manifest.recordedAt) > Date.parse(manifest.frozenNow) ||
    !Number.isFinite(Date.parse(manifest.frozenNow)) ||
    !coverage ||
    !isCppTarget(coverage.target) ||
    manifest.capture?.boards.length !== 6 ||
    fixtures.length !== manifest.graphql.length
  )
    throw new Error('CPP detail coverage requires the complete recorded account and scenario');
  for (const fixture of fixtures) assertFixture(manifest, fixture);
  assertCppGradeCountProof(manifest, fixtures);
  if (
    fixtures.some(
      (fixture) =>
        fixture.operationName === 'SearchClimbs' &&
        normalizeDocument(fixture.query) !== normalizeDocument(SEARCH_CLIMBS),
    )
  )
    throw new Error('CPP detail search differs from the native document');
  const page = readCppPage(coverage.target);
  const variants = [...page.heroBoards, ...page.otherBoards];
  if (Object.keys(coverage.heroClimbs ?? {}).some((id) => !variants.some((variant) => variant.id === id)))
    throw new Error('CPP detail hero scope contains another board');
  if (
    coverage.accessoryClimb &&
    coverage.accessoryClimb.climbId === coverage.heroClimbs?.[page.primaryBoard.id]?.climbId
  )
    throw new Error('CPP detail accessory must be distinct from the primary hero');
  if (new Set(variants.map((variant) => coverage.boardIds?.[variant.id])).size !== 6)
    throw new Error('CPP detail coverage requires six distinct board identities');
  const reads = new Map<string, CppDetailRead>();
  for (const [index, variant] of variants.entries()) {
    const board = ownedBoard(manifest, fixtures, variant);
    if (manifest.capture.boards[index] !== board.name)
      throw new Error('CPP detail board order differs from the captured scenario');
    if (coverage.boardHeroModes?.[variant.id] === 'wall-editor') {
      if (
        variant.family !== 'spray' ||
        coverage.boardClimbCounts?.[variant.id] !== 0 ||
        coverage.heroClimbs?.[variant.id] ||
        (variant.id === page.primaryBoard.id && coverage.accessoryClimb)
      )
        throw new Error('CPP detail wall editor is not an explicitly empty spray wall');
      continue;
    }
    const hero = coverage.heroClimbs?.[variant.id];
    const selected = [
      hero,
      ...(variant.id === page.primaryBoard.id && coverage.accessoryClimb ? [coverage.accessoryClimb] : []),
      ...(variant.id === page.primaryBoard.id && coverage.target !== 'spray'
        ? [
            {
              boardId: coverage.scenes.status?.boardId,
              climbId: coverage.scenes.status?.climbId,
              readyText: coverage.scenes.status?.readyText,
            },
          ]
        : []),
    ];
    for (const climb of selected) {
      if (
        !climb ||
        climb.boardId !== board.uuid ||
        !isCppClimbId(climb.climbId) ||
        typeof climb.readyText !== 'string' ||
        !climb.readyText.trim()
      )
        throw new Error('CPP detail climb is not bound to its recorded board');
      const searches = fixtures.filter((fixture) => fixture.operationName === 'SearchClimbs');
      const found = searches.some((fixture) => {
        if (normalizeDocument(fixture.query) !== normalizeDocument(SEARCH_CLIMBS))
          throw new Error('CPP detail search differs from the native document');
        if (!record(fixture.variables) || !record(fixture.variables.input))
          throw new Error('CPP detail search variables are invalid');
        if (canonicalJson(geometry(fixture.variables.input)) !== canonicalJson(geometry(board))) return false;
        const climbs = fields(fixture, 'searchClimbs').climbs;
        if (!Array.isArray(climbs)) throw new Error('CPP detail search response is invalid');
        return climbs.some(
          (row) =>
            record(row) &&
            row.uuid === climb.climbId &&
            typeof row.name === 'string' &&
            row.name.trim() === climb.readyText.trim() &&
            typeof row.frames === 'string' &&
            row.frames.length > 0,
        );
      });
      if (!found) throw new Error('CPP detail climb lacks genuine native search evidence');
      for (const request of detailReads(variant.boardType, climb.climbId))
        reads.set(`${request.operationName}\n${request.variablesHash}`, request);
    }
  }
  if (!reads.size || reads.size > 24) throw new Error('CPP detail reads exceed the selected scene scope');
  if (coverage.target !== 'spray') {
    const sessionId = manifest.capture.sharedSessionId;
    const queue = fixtures.find(
      (fixture) =>
        fixture.operationName === 'QueueUpdates' &&
        record(fixture.variables) &&
        fixture.variables.sessionId === sessionId,
    );
    const state = queue ? fields(queue, 'queueUpdates').state : undefined;
    const current = record(state) ? state.currentClimbQueueItem : undefined;
    // Evaluate the existing source contract only; never send this hardware mutation.
    if (
      !record(current) ||
      !record(current.climb) ||
      !isCppWallConfirmation(
        CONFIRM_CLIMB_ON_WALL,
        { climbUuid: current.climb.uuid, queueItemUuid: current.uuid },
        manifest,
        fixtures,
      )
    )
      throw new Error('CPP detail source lacks the genuine owned leader primary queue');
  }
  for (const expected of reads.values()) {
    const fixture = fixtures.find(
      (candidate) =>
        candidate.operationName === expected.operationName && candidate.variablesHash === expected.variablesHash,
    );
    if (fixture) assertDetailResponse(fixture, expected);
  }
  return [...reads.values()];
}

function fileHashes(directory: string): Map<string, string> {
  const hashes = new Map<string, string>();
  function visit(relative = ''): void {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const name = join(relative, entry.name);
      const stat = lstatSync(join(directory, name));
      if (stat.isSymbolicLink()) throw new Error('CPP detail recording cannot contain symbolic links');
      if (stat.isDirectory()) visit(name);
      else if (stat.isFile()) hashes.set(name, sha256(readFileSync(join(directory, name))));
      else throw new Error('CPP detail recording contains an unsupported file');
    }
  }
  visit();
  return hashes;
}

function readFixtures(directory: string, manifest: ScreenshotFixtureManifest): GraphqlFixtureFile[] {
  try {
    return manifest.graphql.map(
      (entry) => JSON.parse(readFileSync(join(directory, entry.file), 'utf8')) as GraphqlFixtureFile,
    );
  } catch {
    throw new Error('CPP detail fixture files are invalid');
  }
}

function readManifest(directory: string): ScreenshotFixtureManifest | null {
  try {
    return readScreenshotFixtureManifest(directory);
  } catch {
    throw new Error('CPP detail recording manifest is invalid');
  }
}

function assertOriginalFiles(input: string, recording: string, originalHashes: ReadonlyMap<string, string>): void {
  const sourceAfter = fileHashes(input);
  const recordedHashes = fileHashes(recording);
  for (const [file, hash] of originalHashes) {
    if (sourceAfter.get(file) !== hash || (file !== 'manifest.json' && recordedHashes.get(file) !== hash))
      throw new Error('CPP detail recorder changed an original recording file');
  }
  if (sourceAfter.size !== originalHashes.size) throw new Error('CPP detail recorder changed original recording files');
}

export interface CppDetailRecordingOptions {
  upstream: string;
  email: string;
  password: string;
  log?: (line: string) => void;
}

async function authenticateDetails(origin: string, options: CppDetailRecordingOptions) {
  try {
    return await createTransport(origin, options.email, options.password);
  } catch {
    // Malformed upstream JSON can include response excerpts in parser errors.
    throw new Error('CPP detail authentication failed');
  }
}

/** Extend an owned temporary copy through the real recorder, then hand it to candidate preparation. */
export async function withCppDetailCoverage<T>(
  input: string,
  options: CppDetailRecordingOptions,
  prepare: (recording: string) => Promise<T>,
): Promise<T> {
  const originalHashes = fileHashes(input);
  const manifest = readManifest(input);
  if (!manifest) throw new Error('CPP detail recording manifest is missing');
  const fixtures = readFixtures(input, manifest);
  const reads = resolveCppDetailReads(manifest, fixtures);
  if (manifest.static.some((entry) => lstatSync(join(input, entry.file)).size !== entry.bytes))
    throw new Error('CPP detail source static bytes differ from their manifest');
  const upstream = resolveBootstrapUpstream(options.upstream);
  if (upstream !== manifest.upstream || options.email !== manifest.accountEmail || !options.password)
    throw new Error('CPP detail credentials and upstream must match the recorded account');
  const scenario = process.env.BOARDSESH_SCREENSHOT_CAPTURE_SCENARIO;
  if (scenario) {
    let parsedScenario: unknown;
    try {
      parsedScenario = JSON.parse(scenario);
    } catch {
      throw new Error('CPP detail recorder scenario is invalid');
    }
    if (canonicalJson(parsedScenario) !== canonicalJson(manifest.capture))
      throw new Error('CPP detail recorder scenario differs from the source recording');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'boardsesh-cpp-details-'));
  const recording = join(scratch, 'recording');
  let recorder: ReturnType<typeof createScreenshotBackend> | undefined;
  try {
    cpSync(input, recording, { recursive: true, errorOnExist: true, force: false });
    const missing = reads.filter(
      (expected) =>
        !fixtures.some(
          (fixture) =>
            fixture.operationName === expected.operationName && fixture.variablesHash === expected.variablesHash,
        ),
    );
    if (missing.length === 0) {
      // A resumed complete candidate needs fresh owner verification, but no
      // duplicate recording should move its provenance clock or original bytes.
      const { accountUserId } = await authenticateDetails(upstream, options);
      if (accountUserId !== manifest.accountUserId)
        throw new Error('CPP detail authentication identifies another account');
      assertOriginalFiles(input, recording, originalHashes);
      return await prepare(recording);
    }
    let rejectedResponse = false;
    recorder = createScreenshotBackend({
      mode: 'record',
      fixturesDir: recording,
      upstreamUrl: upstream,
      frozenNow: manifest.frozenNow,
      flow: manifest.flow,
      fresh: false,
      pseudonymise: true,
      log: (line) => {
        if (line.includes('UPSTREAM-ERROR') || line.includes('REDACTED') || line.includes('MISS '))
          rejectedResponse = true;
        // The normal recorder emits bounded diagnostics, never response bodies or credentials.
        options.log?.(line);
      },
    });
    const port = await recorder.listen(0, '127.0.0.1');
    const { transport, accountUserId } = await authenticateDetails(`http://127.0.0.1:${port}`, options);
    if (accountUserId !== manifest.accountUserId)
      throw new Error('CPP detail authentication identifies another account');
    for (const expected of missing) {
      try {
        await transport.request(expected.query, expected.variables);
      } catch {
        throw new Error(`CPP detail ${expected.operationName} read failed`);
      }
    }
    const stats = recorder.stats();
    await recorder.close();
    recorder = undefined;
    if (rejectedResponse || stats.misses || stats.redacted)
      throw new Error('CPP detail recorder refused an upstream response');
    const completed = readManifest(recording);
    if (!completed) throw new Error('CPP detail completed recording is missing');
    const completedFixtures = readFixtures(recording, completed);
    resolveCppDetailReads(completed, completedFixtures);
    for (const expected of reads) {
      const fixture = completedFixtures.find(
        (candidate) =>
          candidate.operationName === expected.operationName && candidate.variablesHash === expected.variablesHash,
      );
      if (!fixture) throw new Error('CPP detail response was not recorded');
      assertDetailResponse(fixture, expected);
    }
    const {
      graphql: _originalGraphql,
      recordedAt: _originalAt,
      frozenNow: _originalNow,
      ...originalMetadata
    } = manifest;
    const {
      graphql: _completedGraphql,
      recordedAt: _completedAt,
      frozenNow: _completedNow,
      ...completedMetadata
    } = completed;
    const incoming = completedFixtures.filter(
      (fixture) =>
        !fixtures.some(
          (previous) =>
            previous.operationName === fixture.operationName && previous.variablesHash === fixture.variablesHash,
        ),
    );
    if (
      incoming.some((fixture) => {
        const expected = reads.find(
          (request) =>
            request.operationName === fixture.operationName && request.variablesHash === fixture.variablesHash,
        );
        if (expected) return false;
        return (
          fixture.operationName !== 'CppBootstrapProfile' ||
          normalizeDocument(fixture.query) !== normalizeDocument(CPP_BOOTSTRAP_PROFILE_QUERY) ||
          canonicalJson(fixture.variables) !== '{}' ||
          fields(fixture, 'profile').id !== manifest.accountUserId
        );
      })
    )
      throw new Error('CPP detail recorder added a request outside its native read scope');
    if (
      canonicalJson(originalMetadata) !== canonicalJson(completedMetadata) ||
      completed.frozenNow !==
        finalizeRecordingFrozenNow(
          manifest.frozenNow,
          incoming.map((fixture) => fixture.recordedAt),
        ) ||
      !Number.isFinite(Date.parse(completed.recordedAt)) ||
      Date.parse(completed.recordedAt) > Date.parse(completed.frozenNow)
    )
      throw new Error('CPP detail recorder changed source identity, scope or clock provenance');
    assertOriginalFiles(input, recording, originalHashes);
    options.log?.(`CPP detail coverage verified: ${reads.length} exact native reads.`);
    return await prepare(recording);
  } finally {
    try {
      await recorder?.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
