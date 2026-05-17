// Opt-in flags for the IDB-backed React Query persisters in
// `query-client-provider.tsx`. Pass one of these as the `meta` field on a
// `useQuery` / `useInfiniteQuery` to participate.
//
// `persistUser`   → user-scoped IDB store (busted on sign-out / user switch).
// `persistShared` → shared IDB store with no buster (climb stats, beta links,
//                   global feeds — same payload for every viewer).
//
// A query may opt in to only one of the two. Don't combine them.

export const persistUser = { persist: true } as const;
export const persistShared = { persistShared: true } as const;
