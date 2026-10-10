import { Kind, parse, print, visit, type SelectionSetNode } from 'graphql';
import { canonicalJson, type GraphqlFixtureFile } from './screenshot-fixtures';

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
