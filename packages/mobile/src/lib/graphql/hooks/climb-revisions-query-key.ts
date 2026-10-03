// The climb-revisions query key, in a file with no imports.
//
// The create-climb editor invalidates this after a save, and it must be able to
// name the key without importing the hook next door: that pulls the GraphQL
// client, and through it `expo-secure-store`, into the editor's module graph.

/** The first segment of every climb-revisions key. Invalidate on this to reach them all. */
export const CLIMB_REVISIONS_QUERY_KEY = 'climbRevisions';

export const climbRevisionsQueryKey = (boardType: string, climbUuid: string) =>
  [CLIMB_REVISIONS_QUERY_KEY, boardType, climbUuid] as const;
