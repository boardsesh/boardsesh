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
  DeletePlaylist: `mutation DeletePlaylist($playlistUuid: ID!) { deletePlaylist(playlistUuid: $playlistUuid) }`,
  AddClimbToPlaylist: `mutation AddClimbToPlaylist($input: AddClimbToPlaylistInput!) { addClimbToPlaylist(input: $input) }`,
  RemoveClimbFromPlaylist: `mutation RemoveClimbFromPlaylist($input: RemoveClimbFromPlaylistInput!) { removeClimbFromPlaylist(input: $input) }`,
  FollowUser: `mutation FollowUser($input: FollowInput!) { followUser(input: $input) }`,
  UnfollowUser: `mutation UnfollowUser($input: FollowInput!) { unfollowUser(input: $input) }`,
  FollowSetter: `mutation FollowSetter($input: FollowSetterInput!) { followSetter(input: $input) }`,
  UnfollowSetter: `mutation UnfollowSetter($input: UnfollowSetterInput!) { unfollowSetter(input: $input) }`,
  FollowPlaylist: `mutation FollowPlaylist($input: FollowPlaylistInput!) { followPlaylist(input: $input) }`,
  UnfollowPlaylist: `mutation UnfollowPlaylist($input: UnfollowPlaylistInput!) { unfollowPlaylist(input: $input) }`,
  PinPlaylist: `mutation PinPlaylist($input: PinPlaylistInput!) { pinPlaylist(input: $input) }`,
  UnpinPlaylist: `mutation UnpinPlaylist($input: UnpinPlaylistInput!) { unpinPlaylist(input: $input) }`,
};

type MutationDispatch = {
  mutationName: string;
  variables: Record<string, unknown>;
};

function buildDispatch(mutation: PendingMutation): MutationDispatch {
  const payload = JSON.parse(mutation.payload) as Record<string, unknown>;

  switch (mutation.table_name) {
    case 'boardsesh_ticks':
      switch (mutation.operation) {
        case 'create':
          return {
            mutationName: 'SaveTick',
            variables: { input: { uuid: mutation.idempotency_key, ...payload } },
          };
        case 'update':
          return {
            mutationName: 'UpdateTick',
            variables: { uuid: payload.uuid, input: payload },
          };
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
            variables: { playlistUuid: payload.uuid },
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
