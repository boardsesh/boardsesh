import type { PendingMutation } from './queue';

export type GraphQLFetch = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

const MUTATIONS: Record<string, string> = {
  SaveTick: `mutation SaveTick($input: SaveTickInput!) { saveTick(input: $input) { uuid } }`,
  UpdateTick: `mutation UpdateTick($uuid: ID!, $input: UpdateTickInput!) { updateTick(uuid: $uuid, input: $input) { uuid } }`,
  DeleteTick: `mutation DeleteTick($uuid: ID!) { deleteTick(uuid: $uuid) }`,
  AddFavorite: `mutation AddFavorite($input: AddFavoriteInput!) { addFavorite(input: $input) }`,
  RemoveFavorite: `mutation RemoveFavorite($input: RemoveFavoriteInput!) { removeFavorite(input: $input) }`,
  CreatePlaylist: `mutation CreatePlaylist($input: CreatePlaylistInput!) { createPlaylist(input: $input) { uuid } }`,
  UpdatePlaylist: `mutation UpdatePlaylist($input: UpdatePlaylistInput!) { updatePlaylist(input: $input) { uuid } }`,
  DeletePlaylist: `mutation DeletePlaylist($playlistId: ID!) { deletePlaylist(playlistId: $playlistId) }`,
  AddClimbToPlaylist: `mutation AddClimbToPlaylist($input: AddClimbToPlaylistInput!) { addClimbToPlaylist(input: $input) { id } }`,
  RemoveClimbFromPlaylist: `mutation RemoveClimbFromPlaylist($input: RemoveClimbFromPlaylistInput!) { removeClimbFromPlaylist(input: $input) }`,
  ReorderPlaylistClimb: `mutation ReorderPlaylistClimb($input: ReorderPlaylistClimbInput!) { reorderPlaylistClimb(input: $input) }`,
  FollowUser: `mutation FollowUser($input: FollowInput!) { followUser(input: $input) }`,
  UnfollowUser: `mutation UnfollowUser($input: FollowInput!) { unfollowUser(input: $input) }`,
  FollowSetter: `mutation FollowSetter($input: FollowSetterInput!) { followSetter(input: $input) }`,
  UnfollowSetter: `mutation UnfollowSetter($input: FollowSetterInput!) { unfollowSetter(input: $input) }`,
  FollowPlaylist: `mutation FollowPlaylist($input: FollowPlaylistInput!) { followPlaylist(input: $input) }`,
  UnfollowPlaylist: `mutation UnfollowPlaylist($input: FollowPlaylistInput!) { unfollowPlaylist(input: $input) }`,
  PinPlaylist: `mutation PinPlaylist($input: PinPlaylistInput!) { pinPlaylist(input: $input) }`,
  UnpinPlaylist: `mutation UnpinPlaylist($input: PinPlaylistInput!) { unpinPlaylist(input: $input) }`,
};

type MutationDispatch = {
  mutationName: string;
  variables: Record<string, unknown>;
};

// UpdateTickInput's exact field set (shared-schema ticks.ts). Queued payloads
// carry the camelCase GraphQL input shape, so no case mapping is needed.
// Drift is caught at typecheck time by the assertion in handlers.test.ts
// (this runtime package deliberately has no dependencies, so the type-only
// check lives with the tests).
export const UPDATE_TICK_INPUT_FIELDS = [
  'status',
  'attemptCount',
  'quality',
  'difficulty',
  'isBenchmark',
  'comment',
  'climbedAt',
  'angle',
] as const;

function buildDispatch(mutation: PendingMutation): MutationDispatch {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(mutation.payload) as Record<string, unknown>;
  } catch {
    // A corrupt payload dead-letters (no status → non-retryable), so this
    // message IS the dead-letter row's last_error — carry enough context to
    // debug it without the row in hand.
    throw new Error(
      `Corrupt queued payload for ${mutation.table_name}/${mutation.operation} (id=${mutation.id}, key=${mutation.idempotency_key}): not valid JSON`,
    );
  }

  switch (mutation.table_name) {
    case 'boardsesh_ticks':
      switch (mutation.operation) {
        case 'create':
          return {
            mutationName: 'SaveTick',
            variables: { input: { uuid: mutation.idempotency_key, ...payload } },
          };
        case 'update': {
          // UpdateTickInput has no `uuid` field — it rides as a separate
          // variable — and GraphQL rejects unknown input fields, dead-lettering
          // the mutation. Copy only UpdateTickInput's exact field set instead
          // of spreading the payload, so stray keys (uuid, local timestamps)
          // never reach the server.
          const updateInput: Record<string, unknown> = {};
          for (const field of UPDATE_TICK_INPUT_FIELDS) {
            if (payload[field] !== undefined) {
              updateInput[field] = payload[field];
            }
          }
          return {
            mutationName: 'UpdateTick',
            variables: { uuid: payload.uuid, input: updateInput },
          };
        }
        case 'delete':
          return {
            mutationName: 'DeleteTick',
            variables: { uuid: payload.uuid },
          };
        default:
          throw new Error(`Unknown operation "${mutation.operation}" for table "${mutation.table_name}"`);
      }

    case 'user_favorites':
      switch (mutation.operation) {
        case 'create':
          return {
            mutationName: 'AddFavorite',
            variables: { input: payload },
          };
        case 'delete':
          return {
            mutationName: 'RemoveFavorite',
            variables: { input: payload },
          };
        default:
          throw new Error(`Unknown operation "${mutation.operation}" for table "${mutation.table_name}"`);
      }

    case 'playlists':
      switch (mutation.operation) {
        case 'create':
          return {
            mutationName: 'CreatePlaylist',
            variables: { input: { uuid: mutation.idempotency_key, ...payload } },
          };
        case 'update':
          return {
            mutationName: 'UpdatePlaylist',
            variables: { input: payload },
          };
        case 'delete':
          return {
            mutationName: 'DeletePlaylist',
            variables: { playlistId: payload.uuid },
          };
        default:
          throw new Error(`Unknown operation "${mutation.operation}" for table "${mutation.table_name}"`);
      }

    case 'playlist_climbs':
      switch (mutation.operation) {
        case 'create':
          return {
            mutationName: 'AddClimbToPlaylist',
            variables: { input: payload },
          };
        case 'delete':
          return {
            mutationName: 'RemoveClimbFromPlaylist',
            variables: { input: payload },
          };
        case 'update':
          return {
            mutationName: 'ReorderPlaylistClimb',
            variables: { input: payload },
          };
        default:
          throw new Error(`Unknown operation "${mutation.operation}" for table "${mutation.table_name}"`);
      }

    case 'user_follows':
      switch (mutation.operation) {
        case 'create':
          return {
            mutationName: 'FollowUser',
            variables: { input: { userId: payload.followingId } },
          };
        case 'delete':
          return {
            mutationName: 'UnfollowUser',
            variables: { input: { userId: payload.followingId } },
          };
        default:
          throw new Error(`Unknown operation "${mutation.operation}" for table "${mutation.table_name}"`);
      }

    case 'setter_follows':
      switch (mutation.operation) {
        case 'create':
          return {
            mutationName: 'FollowSetter',
            variables: { input: { setterUsername: payload.setterUsername } },
          };
        case 'delete':
          return {
            mutationName: 'UnfollowSetter',
            variables: { input: { setterUsername: payload.setterUsername } },
          };
        default:
          throw new Error(`Unknown operation "${mutation.operation}" for table "${mutation.table_name}"`);
      }

    case 'playlist_follows':
      switch (mutation.operation) {
        case 'create':
          return {
            mutationName: 'FollowPlaylist',
            variables: { input: { playlistUuid: payload.playlistUuid } },
          };
        case 'delete':
          return {
            mutationName: 'UnfollowPlaylist',
            variables: { input: { playlistUuid: payload.playlistUuid } },
          };
        default:
          throw new Error(`Unknown operation "${mutation.operation}" for table "${mutation.table_name}"`);
      }

    case 'user_playlist_pins':
      switch (mutation.operation) {
        case 'create':
          return {
            mutationName: 'PinPlaylist',
            variables: { input: { playlistUuid: payload.playlistUuid } },
          };
        case 'delete':
          return {
            mutationName: 'UnpinPlaylist',
            variables: { input: { playlistUuid: payload.playlistUuid } },
          };
        default:
          throw new Error(`Unknown operation "${mutation.operation}" for table "${mutation.table_name}"`);
      }

    default:
      throw new Error(`Unknown table "${mutation.table_name}"`);
  }
}

export async function processMutation(mutation: PendingMutation, graphqlFetch: GraphQLFetch): Promise<void> {
  const { mutationName, variables } = buildDispatch(mutation);
  const query = MUTATIONS[mutationName];
  if (!query) {
    throw new Error(`No GraphQL mutation defined for "${mutationName}"`);
  }
  await graphqlFetch(query, variables);
}
