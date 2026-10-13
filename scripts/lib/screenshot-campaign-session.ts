import { Kind, parse, print, visit, type SelectionSetNode } from 'graphql';
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  graphqlFixtureKey,
  STATIC_KEY_LENGTH,
  type GraphqlFixtureFile,
  type ScreenshotFixtureManifest,
} from './screenshot-fixtures';
import { isCppAscentId, isCppClimbId, isCppTarget, readCppPage } from './screenshot-cpp';
import { JOIN_SESSION } from '../../packages/shared/graphql/src/operations/queue-session';
import {
  GET_MY_BOARDS,
  SEARCH_CLIMBS,
  QUEUE_UPDATES_SUBSCRIPTION,
} from '../../packages/mobile/src/lib/graphql/operations';

export { NATIVE_IOS_QUEUE_UPDATES as NATIVE_CAMPAIGN_QUEUE_QUERY } from '../../packages/shared/graphql/src/operations/queue-session';
import { NATIVE_IOS_QUEUE_UPDATES as NATIVE_CAMPAIGN_QUEUE_QUERY } from '../../packages/shared/graphql/src/operations/queue-session';
import { CONFIRM_CLIMB_ON_WALL } from '../../packages/shared/graphql/src/operations/queue-session';

export const NATIVE_CAMPAIGN_JOIN_QUERY = `
mutation JoinSession($sessionId: ID!, $boardPath: String!) {
  joinSession(sessionId: $sessionId, boardPath: $boardPath) {
    id
    clientId
  }
}
`;

export const NATIVE_CAMPAIGN_REGISTER_QUERY = `mutation RegisterToken($sessionId: ID!, $token: String!) { registerActivityPushToken(sessionId: $sessionId, token: $token) }`;

/** Selection ordering has no GraphQL meaning; every argument, alias and type remains significant. */
export function canonicalCampaignDocument(query: string): string {
  return print(
    visit(parse(query), {
      SelectionSet: {
        leave(node) {
          return {
            ...node,
            selections: [...node.selections].sort((left, right) => print(left).localeCompare(print(right))),
          };
        },
      },
    }),
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Preparation-only named-board variant: verify the recorded board before changing the resolver's echoed path. */
export function campaignNamedBoardJoinResponse(
  query: string,
  variables: unknown,
  fixture: GraphqlFixtureFile,
  recordedBoards: readonly unknown[],
): { response: unknown } | null {
  try {
    if (
      fixture.operationName !== 'JoinSession' ||
      canonicalCampaignDocument(query) !== canonicalCampaignDocument(fixture.query)
    )
      return null;
    if (!record(variables) || !record(fixture.variables)) return null;
    const { boardPath: requestedPath, ...requestedIdentity } = variables;
    const { boardPath: sourcePath, ...recordedIdentity } = fixture.variables;
    if (canonicalJson(requestedIdentity) !== canonicalJson(recordedIdentity)) return null;
    if (typeof requestedPath !== 'string' || typeof sourcePath !== 'string') return null;
    const named = /^\/b\/([^/]+)\/(\d+(?:\.\d+)?)$/.exec(requestedPath);
    const tuple = sourcePath.split('/').filter(Boolean);
    if (!named || tuple.length !== 5 || Number(named[2]) !== Number(tuple[4])) return null;
    const boards = recordedBoards.filter((board) => record(board) && board.slug === named[1]);
    if (boards.length !== 1 || !record(boards[0])) return null;
    const board = boards[0];
    const sets = (raw: string) => raw.split(',').sort().join(',');
    if (
      board.boardType !== tuple[0] ||
      board.layoutId !== Number(tuple[1]) ||
      board.sizeId !== Number(tuple[2]) ||
      typeof board.setIds !== 'string' ||
      sets(board.setIds) !== sets(tuple[3]) ||
      board.angle !== Number(tuple[4])
    )
      return null;
    if (
      !record(fixture.response) ||
      !record(fixture.response.data) ||
      !record(fixture.response.data.joinSession) ||
      fixture.response.errors
    )
      return null;
    if (fixture.response.data.joinSession.boardPath !== sourcePath) return null;
    return {
      response: {
        ...fixture.response,
        data: {
          ...fixture.response.data,
          joinSession: { ...fixture.response.data.joinSession, boardPath: requestedPath },
        },
      },
    };
  } catch {
    return null;
  }
}

/** Project only present recorded fields. Missing fields fail, including nullable fields never recorded. */
function projectRecorded(value: unknown, selection: SelectionSetNode): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => projectRecorded(item, selection));
  if (!record(value)) throw new Error('Recorded selection is not an object');
  const projected: Record<string, unknown> = {};
  for (const selected of selection.selections) {
    if (selected.kind === Kind.INLINE_FRAGMENT) {
      if (selected.typeCondition?.name.value !== value.__typename) continue;
      Object.assign(projected, projectRecorded(value, selected.selectionSet));
    } else if (selected.kind === Kind.FIELD) {
      const key = selected.alias?.value ?? selected.name.value;
      if (!(key in value)) throw new Error('Selected field was not recorded');
      projected[key] = selected.selectionSet ? projectRecorded(value[key], selected.selectionSet) : value[key];
    } else throw new Error('Fragment spreads are not supported');
  }
  return projected;
}

/** Campaign-only adapter for the two pinned native clients; never changes recorded queue or identity values. */
export function replayCampaignSessionResponse(
  query: string,
  variables: unknown,
  fixture: GraphqlFixtureFile,
): { response: unknown } | null {
  try {
    if (!record(variables) || !record(fixture.variables)) return null;
    const requested = canonicalCampaignDocument(query);
    if (fixture.operationName === 'QueueUpdates') {
      if (canonicalJson(variables) !== canonicalJson(fixture.variables)) return null;
      if (requested === canonicalCampaignDocument(fixture.query)) return { response: fixture.response };
      if (requested !== canonicalCampaignDocument(NATIVE_CAMPAIGN_QUEUE_QUERY)) return null;
    } else if (fixture.operationName === 'JoinSession') {
      if (requested !== canonicalCampaignDocument(NATIVE_CAMPAIGN_JOIN_QUERY)) return null;
      if (Object.keys(variables).sort().join(',') !== 'boardPath,sessionId') return null;
      if (variables.sessionId !== fixture.variables.sessionId) return null;
      const requestedPath =
        typeof variables.boardPath === 'string' ? variables.boardPath.split('/').filter(Boolean) : [];
      const recordedPath =
        typeof fixture.variables.boardPath === 'string' ? fixture.variables.boardPath.split('/').filter(Boolean) : [];
      // Native uses angle zero but selects only id/clientId, neither depends on angle.
      if (
        requestedPath.length !== 5 ||
        requestedPath[4] !== '0' ||
        recordedPath.length !== 5 ||
        requestedPath.slice(0, 4).join('/') !== recordedPath.slice(0, 4).join('/')
      )
        return null;
    } else return null;
    if (!record(fixture.response) || !record(fixture.response.data) || fixture.response.errors) return null;
    const operation = parse(query).definitions[0];
    if (operation?.kind !== Kind.OPERATION_DEFINITION) return null;
    return { response: { data: projectRecorded(fixture.response.data, operation.selectionSet) } };
  } catch {
    return null;
  }
}

/** Local ActivityKit visuals do not require APNs. Refuse registration without contacting production. */
export function isCampaignPushRegistration(query: string): boolean {
  try {
    return canonicalCampaignDocument(query) === canonicalCampaignDocument(NATIVE_CAMPAIGN_REGISTER_QUERY);
  } catch {
    return false;
  }
}

/** A simulator link cannot confirm physical LEDs. Only the recorded crew's matching board climb is recognized. */
export function isCampaignWallConfirmation(
  query: string,
  variables: unknown,
  queueFixture: GraphqlFixtureFile,
  joinFixture: GraphqlFixtureFile,
): boolean {
  try {
    if (queueFixture.operationName !== 'QueueUpdates' || joinFixture.operationName !== 'JoinSession') return false;
    if (canonicalCampaignDocument(query) !== canonicalCampaignDocument(CONFIRM_CLIMB_ON_WALL)) return false;
    if (!record(variables) || Object.keys(variables).some((key) => !['climbUuid', 'queueItemUuid'].includes(key)))
      return false;
    if (
      !record(queueFixture.variables) ||
      !record(joinFixture.variables) ||
      queueFixture.variables.sessionId !== joinFixture.variables.sessionId
    )
      return false;
    const path =
      typeof joinFixture.variables.boardPath === 'string'
        ? joinFixture.variables.boardPath.split('/').filter(Boolean)
        : [];
    if (path.length !== 5) return false;
    const response = queueFixture.response;
    if (
      !record(response) ||
      !record(response.data) ||
      !record(response.data.queueUpdates) ||
      !record(response.data.queueUpdates.state)
    )
      return false;
    const queue = response.data.queueUpdates.state.queue;
    if (!Array.isArray(queue)) return false;
    return queue.some(
      (item) =>
        record(item) &&
        record(item.climb) &&
        item.climb.uuid === variables.climbUuid &&
        item.climb.boardType === path[0] &&
        item.climb.layoutId === Number(path[1]) &&
        (variables.queueItemUuid == null || variables.queueItemUuid === item.uuid),
    );
  } catch {
    return false;
  }
}

/** Recognize only the CPP primary's recorded current climb; this authorizes a disabled error, never LEDs. */
export function isCppWallConfirmation(
  query: string,
  variables: unknown,
  manifest: ScreenshotFixtureManifest,
  fixtures: readonly GraphqlFixtureFile[],
): boolean {
  try {
    const coverage = manifest.capture?.cpp;
    const sessionId = manifest.capture?.sharedSessionId;
    if (
      manifest.formatVersion !== 1 ||
      manifest.flow !== 'app-store-cpp' ||
      !coverage ||
      !isCppTarget(coverage.target) ||
      coverage.target === 'spray' ||
      !isCppAscentId(sessionId) ||
      !isCppAscentId(manifest.accountUserId)
    )
      return false;
    const primary = readCppPage(coverage.target).primaryBoard;
    const boardId = coverage.boardIds?.[primary.id];
    const hero = coverage.heroClimbs?.[primary.id];
    const status = coverage.scenes.status;
    const statusTitle = typeof status?.readyText === 'string' ? status.readyText.trim() : '';
    if (
      !isCppAscentId(boardId) ||
      !hero ||
      hero.boardId !== boardId ||
      !isCppClimbId(hero.climbId) ||
      hero.statsAngle !== primary.angle ||
      ['search', 'queue', 'status', 'island'].some((scene) => coverage.scenes[scene]?.boardId !== boardId) ||
      coverage.scenes.queue.sessionId !== sessionId ||
      !isCppClimbId(status?.climbId) ||
      !statusTitle ||
      coverage.scenes.island?.readyText.trim() !== statusTitle ||
      !record(variables) ||
      variables.climbUuid !== status.climbId
    )
      return false;

    const sourceDocuments = new Map([
      ['GetMyBoards', GET_MY_BOARDS],
      ['SearchClimbs', SEARCH_CLIMBS],
      ['JoinSession', JOIN_SESSION],
      ['QueueUpdates', QUEUE_UPDATES_SUBSCRIPTION],
    ]);
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
    const frozenTime = Date.parse(manifest.frozenNow);
    if (!Number.isFinite(frozenTime)) return false;
    const evidence = fixtures.filter((fixture) => sourceDocuments.has(fixture.operationName));
    if (
      new Set(evidence.map((fixture) => `${fixture.operationName}\n${fixture.variablesHash}`)).size !== evidence.length
    )
      return false;
    if (
      evidence.some((fixture) => {
        const sourceQuery = sourceDocuments.get(fixture.operationName)!;
        const key = graphqlFixtureKey(fixture, sha256);
        const entries = manifest.graphql.filter(
          (entry) => entry.operationName === fixture.operationName && entry.variablesHash === key.variablesHash,
        );
        return (
          fixture.formatVersion !== 1 ||
          fixture.status !== 200 ||
          fixture.upstream !== manifest.upstream ||
          !Number.isFinite(Date.parse(fixture.recordedAt)) ||
          Date.parse(fixture.recordedAt) > frozenTime ||
          !record(fixture.response) ||
          fixture.response.errors !== undefined ||
          fixture.documentHash !== key.documentHash ||
          fixture.variablesHash !== key.variablesHash ||
          canonicalCampaignDocument(fixture.query) !== canonicalCampaignDocument(sourceQuery) ||
          entries.length !== 1 ||
          entries[0].documentHash !== key.documentHash ||
          entries[0].file !== `graphql/${key.operationName}/${key.variablesHash.slice(0, STATIC_KEY_LENGTH)}.json`
        );
      })
    )
      return false;

    const setsMatch = (setIds: unknown): boolean => {
      if (typeof setIds !== 'string' || !primary.setIds) return false;
      const sets = setIds.split(',').map(Number);
      return (
        sets.every((setId) => Number.isSafeInteger(setId) && setId > 0) &&
        new Set(sets).size === sets.length &&
        canonicalJson(sets.sort((left, right) => left - right)) ===
          canonicalJson([...primary.setIds].sort((left, right) => left - right))
      );
    };
    const geometryMatches = (board: Record<string, unknown>, familyKey = 'boardType'): boolean =>
      board[familyKey] === primary.boardType &&
      board.layoutId === primary.layoutId &&
      board.sizeId === primary.sizeId &&
      board.angle === primary.angle &&
      setsMatch(board.setIds);
    const responseField = (fixture: GraphqlFixtureFile, field: string): Record<string, unknown> | null => {
      if (!record(fixture.response) || !record(fixture.response.data)) return null;
      const selected = fixture.response.data[field];
      return record(selected) ? selected : null;
    };
    const ownedBoards: Record<string, unknown>[] = [];
    for (const fixture of evidence.filter((fixture) => fixture.operationName === 'GetMyBoards')) {
      const roster = responseField(fixture, 'myBoards');
      if (!roster || !Array.isArray(roster.boards)) return false;
      const matches = roster.boards.filter((board) => record(board) && board.uuid === boardId);
      if (matches.length > 1) return false;
      ownedBoards.push(...matches.filter(record));
    }
    if (
      ownedBoards.length === 0 ||
      ownedBoards.some(
        (board) =>
          board.ownerId !== manifest.accountUserId ||
          board.isPublic !== false ||
          board.canEdit !== true ||
          !geometryMatches(board),
      )
    )
      return false;

    const crew = evidence.filter(
      (fixture) =>
        ['JoinSession', 'QueueUpdates'].includes(fixture.operationName) &&
        record(fixture.variables) &&
        fixture.variables.sessionId === sessionId,
    );
    const joins = crew.filter((fixture) => fixture.operationName === 'JoinSession');
    const queues = crew.filter((fixture) => fixture.operationName === 'QueueUpdates');
    if (joins.length !== 1 || queues.length !== 1) return false;
    const joined = joins[0];
    const queue = queues[0];
    if (!isCampaignWallConfirmation(query, variables, queue, joined) || !record(joined.variables)) return false;
    const path = typeof joined.variables.boardPath === 'string' ? joined.variables.boardPath.split('/') : [];
    if (
      path.length !== 5 ||
      !geometryMatches({
        boardType: path[0],
        layoutId: Number(path[1]),
        sizeId: Number(path[2]),
        setIds: path[3],
        angle: Number(path[4]),
      })
    )
      return false;
    const joinResponse = responseField(joined, 'joinSession');
    const queueResponse = responseField(queue, 'queueUpdates');
    if (
      !joinResponse ||
      joinResponse.id !== sessionId ||
      joinResponse.boardPath !== joined.variables.boardPath ||
      joinResponse.isPublic !== false ||
      joinResponse.isLeader !== true ||
      !Array.isArray(joinResponse.users) ||
      !queueResponse ||
      queueResponse.__typename !== 'FullSync'
    )
      return false;
    const owners = joinResponse.users.filter(
      (participant) => record(participant) && participant.userId === manifest.accountUserId,
    );
    if (owners.length !== 1 || !record(owners[0]) || owners[0].isLeader !== true) return false;
    const sameClimb = (first: unknown, second: unknown): boolean =>
      record(first) &&
      record(second) &&
      ['uuid', 'boardType', 'layoutId', 'angle', 'frames'].every((field) => first[field] === second[field]);
    const currentItem = (state: unknown): Record<string, unknown> | null => {
      if (!record(state) || !Array.isArray(state.queue) || !record(state.currentClimbQueueItem)) return null;
      const current = state.currentClimbQueueItem;
      if (!isCppAscentId(current.uuid) || !record(current.climb)) return null;
      if (
        state.queue.some(
          (item) =>
            !record(item) ||
            !record(item.climb) ||
            item.climb.boardType !== primary.boardType ||
            item.climb.layoutId !== primary.layoutId ||
            item.climb.angle !== primary.angle ||
            typeof item.climb.frames !== 'string' ||
            !item.climb.frames.trim(),
        )
      )
        return null;
      const entries = state.queue.filter((item) => record(item) && item.uuid === current.uuid);
      return entries.length === 1 && record(entries[0]) && sameClimb(entries[0].climb, current.climb) ? current : null;
    };
    const joinedCurrent = currentItem(joinResponse.queueState);
    const syncedCurrent = currentItem(queueResponse.state);
    if (
      !joinedCurrent ||
      !syncedCurrent ||
      joinedCurrent.uuid !== syncedCurrent.uuid ||
      !record(syncedCurrent.climb) ||
      syncedCurrent.climb.uuid !== status.climbId ||
      typeof syncedCurrent.climb.name !== 'string' ||
      syncedCurrent.climb.name.trim() !== statusTitle ||
      !sameClimb(joinedCurrent.climb, syncedCurrent.climb) ||
      (variables.queueItemUuid != null && variables.queueItemUuid !== syncedCurrent.uuid)
    )
      return false;

    const searchedClimbs: unknown[] = [];
    const searchedHeroes: unknown[] = [];
    for (const fixture of evidence.filter((fixture) => fixture.operationName === 'SearchClimbs')) {
      if (
        !record(fixture.variables) ||
        !record(fixture.variables.input) ||
        !geometryMatches(fixture.variables.input, 'boardName')
      )
        continue;
      const search = responseField(fixture, 'searchClimbs');
      if (!search || !Array.isArray(search.climbs)) return false;
      searchedClimbs.push(...search.climbs.filter((climb) => record(climb) && climb.uuid === status.climbId));
      searchedHeroes.push(...search.climbs.filter((climb) => record(climb) && climb.uuid === hero.climbId));
    }
    return (
      searchedClimbs.length > 0 &&
      searchedClimbs.every(
        (climb) =>
          record(climb) &&
          sameClimb(climb, syncedCurrent.climb) &&
          typeof climb.name === 'string' &&
          climb.name.trim() === statusTitle,
      ) &&
      searchedHeroes.length > 0 &&
      searchedHeroes.every(
        (climb) =>
          record(climb) &&
          sameClimb(climb, searchedHeroes[0]) &&
          climb.boardType === primary.boardType &&
          climb.layoutId === primary.layoutId &&
          climb.angle === primary.angle &&
          typeof climb.name === 'string' &&
          climb.name.trim() === hero.readyText.trim() &&
          typeof climb.frames === 'string' &&
          !!climb.frames.trim(),
      )
    );
  } catch {
    return false;
  }
}
