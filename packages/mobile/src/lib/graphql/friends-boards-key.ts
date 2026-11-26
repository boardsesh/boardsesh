/**
 * Root React Query key for `friendsBoards` (the picker's Friends' boards shelf
 * and "Whose board?").
 *
 * Its own module, with zero imports, so the notification stream can refresh the
 * list on a new follower without reaching the GraphQL client (and Expo) that
 * `use-friends-boards` imports.
 */
export const FRIENDS_BOARDS_QUERY_KEY = 'friendsBoards';
