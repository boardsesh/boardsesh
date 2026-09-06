/**
 * Root React Query key for the actors behind one notification group.
 *
 * Its own module, with zero imports, because the two files that need it can't
 * import each other: `use-notifications` (the reader) reaches expo-secure-store
 * for its auth gate, and `use-social` (the writer, which invalidates this key
 * after a follow-back) IS re-exported from the hooks barrel — where any new
 * native reach makes Rolldown's scan hit react-native's Flow source and fail
 * every suite that mocks only the GraphQL client.
 *
 * A duplicated literal in both files would work today and silently break the
 * follow-back cache flush the day one of them is renamed. One constant, no
 * native reach, no drift.
 */
export const NOTIFICATION_ACTORS_QUERY_KEY = 'notificationActors' as const;
