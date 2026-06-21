## Claude Review

⚠️ **Needs attention** - One missing authorization check in `reportBoardClimb` lets any authenticated user post to any board; two read endpoints have no auth with no explanation; migration missing `CONCURRENTLY`.

---

### Security

**`reportBoardClimb` —"missing board membership check** (`packages/backend/src/graphql/resolvers/board-presence/mutations.ts`, lines 166–234)

The mutation requires authentication and rate-limits to 60/min, but never verifies the caller has any relationship to the target board. Any authenticated user who knows or guesses a `boardId` can inject climb reports onto that board's feed. Sender identity is correctly server-derived so names can't be forged, but board access is unguarded.

Suggested fix before the profile lookup:

- Query `userBoards` where `id = boardId AND ownerId = ctx.userId AND deletedAt IS NULL`
- Throw `GraphQLError('Not authorized for this board')` if no row found

---

**`boardRecentClimbs` / `boardPresenceStats` — no authentication** (`packages/backend/src/graphql/resolvers/board-presence/queries.ts`, lines 14–22 and 34–50)

Both resolvers accept `_ctx: ConnectionContext` and never use it. `boardPresenceStats` queries `boardsesh_ticks` with no access control. The subscription explicitly documents "membership-free" access with a rationale comment; these queries have no such comment. If public read is intentional, add the same comment. If not, add `requireAuthenticated(ctx)`.

---

### Database

**Migration 0121 — index creation without `CONCURRENTLY`** (`packages/db/drizzle/0121_abnormal_masked_marvel.sql`, line 1)

`CREATE UNIQUEINDEX "user_boards_unique_serial" ON "user_boards"` takes a write lock for the full index build. Table is small today but the pattern is worth fixing before it grows.

---

### Performance

**N+1 profile query per climb report** (`mutations.ts`, ~lines 183–197)

Every `reportBoardClimb` call joins `users` + `userProfiles` to build sender metadata. At 60/min with multiple concurrent players this is a steady stream of identical queries for data that does not change mid-session. Resolve the caller's display name/avatar once at connection time or cache with a short TTL.
