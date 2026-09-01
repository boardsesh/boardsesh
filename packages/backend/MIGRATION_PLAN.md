# Backend GraphQL Migration Plan

Migrate the backend from Express to GraphQL Yoga, then reimplement Next.js REST APIs as GraphQL queries/mutations.

## Decisions

- **Database**: Use `@boardsesh/db` directly - backend connects to same PostgreSQL database
- **Server**: Pure GraphQL Yoga (replace Express entirely)
- **Authentication**: JWT in Authorization header (same as WebSocket auth)
- **Scope**: High priority APIs first, incremental implementation
- **Exclusions**: Aurora proxy routes (`/api/v1/[board_name]/proxy/*`) stay in Next.js _(superseded — deleted: W-25a (#4441) removed three routes and put `login`/`saveAscent` behind 410, then W-25b (#4443) deleted the last two URLs ahead of the published sunset of 2026-10-01)_

---

## Phase 1: Express to GraphQL Yoga Migration ✅ COMPLETED

**PR**: [#421](https://github.com/marcodejongh/boardsesh/pull/421)

### Changes Made

| File                      | Description                                         |
| ------------------------- | --------------------------------------------------- |
| `src/server.ts`           | Rewritten with Yoga + custom request router         |
| `src/handlers/cors.ts`    | CORS utility with origin validation                 |
| `src/handlers/health.ts`  | Health check endpoint                               |
| `src/handlers/join.ts`    | Session redirect handler                            |
| `src/handlers/avatars.ts` | Avatar upload with busboy (replaced multer)         |
| `src/handlers/static.ts`  | Static file serving                                 |
| `src/graphql/yoga.ts`     | Yoga instance configuration                         |
| `src/websocket/setup.ts`  | graphql-ws integration                              |
| `package.json`            | Added graphql-yoga, busboy; removed express, multer |

### Architecture

```
Node.js HTTP Server
  |-- Custom Request Router
        |-- /graphql (GET/POST) --> GraphQL Yoga handler
        |-- /health             --> Health check handler
        |-- /join/:sessionId    --> Session redirect handler
        |-- /api/avatars        --> Avatar upload (busboy)
        |-- /static/avatars/*   --> Static file handler
  |-- WebSocketServer (/graphql) --> graphql-ws with existing schema
```

---

## Phase 2: REST API Reimplementation (IN PROGRESS)

Reimplement Next.js REST APIs as GraphQL queries/mutations. Only endpoints that query our database - Aurora proxy routes stay in Next.js _(superseded — deleted by W-25a (#4441) + W-25b (#4443); see §2.5)_.

### 2.1 Board Configuration Queries (High Priority)

| REST Endpoint                                                      | GraphQL Operation                                  | Status               |
| ------------------------------------------------------------------ | -------------------------------------------------- | -------------------- |
| `GET /api/v1/grades/[board_name]`                                  | `Query.grades(boardName: String!)`                 | ✅ DONE              |
| `GET /api/v1/angles/[board_name]/[layout_id]`                      | `Query.angles(boardName: String!, layoutId: Int!)` | ✅ DONE              |
| `GET /api/v1/[board_name]/[layout_id]/[size_id]/[set_ids]/details` | `Query.boardDetails(...)`                          | SKIP (being removed) |

**Source files:**

- `packages/web/app/api/v1/grades/[board_name]/route.ts`
- `packages/web/app/api/v1/angles/[board_name]/[layout_id]/route.ts`
- `packages/web/app/api/v1/[board_name]/[layout_id]/[size_id]/[set_ids]/details/route.ts`

### 2.2 Climb Queries (High Priority)

| REST Endpoint                               | GraphQL Operation                              | Status                         |
| ------------------------------------------- | ---------------------------------------------- | ------------------------------ |
| `GET /api/v1/[board_name]/.../search`       | `Query.searchClimbs(input: ClimbSearchInput!)` | ✅ DONE (stub - returns empty) |
| `GET /api/v1/[board_name]/.../[climb_uuid]` | `Query.climb(...)`                             | ✅ DONE (stub - returns null)  |

**Medium Priority:**

| REST Endpoint                                       | GraphQL Operation       | Status |
| --------------------------------------------------- | ----------------------- | ------ |
| `GET /api/v1/[board_name]/climb-stats/[climb_uuid]` | `Query.climbStats(...)` | TODO   |
| `GET /api/v1/[board_name]/.../heatmap`              | `Query.heatmap(...)`    | TODO   |
| `GET /api/v1/[board_name]/.../setters`              | `Query.setters(...)`    | TODO   |

**Low Priority:**

| REST Endpoint                                | GraphQL Operation      | Status |
| -------------------------------------------- | ---------------------- | ------ |
| `GET /api/v1/[board_name]/beta/[climb_uuid]` | `Query.betaLinks(...)` | TODO   |

### 2.3 Slug Lookups (Medium Priority)

| REST Endpoint                                            | GraphQL Operation         | Status |
| -------------------------------------------------------- | ------------------------- | ------ |
| `GET /api/v1/[board_name]/slugs/layout/[slug]`           | `Query.layoutBySlug(...)` | TODO   |
| `GET /api/v1/[board_name]/slugs/size/[layout_id]/[slug]` | `Query.sizeBySlug(...)`   | TODO   |
| `GET /api/v1/[board_name]/slugs/sets/.../[slug]`         | `Query.setsBySlug(...)`   | TODO   |

### 2.4 User Management (High Priority)

| REST Endpoint                           | Backend Operation                        | Status                                                                                                                         |
| --------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/internal/profile`             | `Query.profile`                          | ⚠️ GraphQL exists, REST still live — `/settings` (`settings-page-content.tsx`) has no GraphQL caller yet, not decommissionable |
| `PUT /api/internal/profile`             | `Mutation.updateProfile(...)`            | ✅ DONE — zero REST callers, superseded (see #1889)                                                                            |
| `POST /api/internal/profile/avatar`     | `Mutation.uploadAvatar(...)`             | TODO                                                                                                                           |
| `GET /api/internal/favorites`           | `Query.favorites(...)`                   | ✅ DONE                                                                                                                        |
| `POST /api/internal/favorites`          | `Mutation.toggleFavorite(...)`           | ✅ DONE                                                                                                                        |
| `GET /api/aurora-credentials`           | Backend REST + `Query.auroraCredentials` | ✅ DONE                                                                                                                        |
| `GET /api/aurora-credentials/unsynced`  | Backend REST                             | ✅ DONE                                                                                                                        |
| `POST /api/aurora-credentials`          | Backend REST + shared credential service | ✅ DONE                                                                                                                        |
| `DELETE /api/aurora-credentials`        | Backend REST + shared credential service | ✅ DONE                                                                                                                        |
| `POST /api/board-credentials/kilter/*`  | Backend REST OAuth handoff/finalize      | ✅ DONE                                                                                                                        |
| `GET /api/internal/user-board-mapping`  | n/a — route deleted in W-19 (#4437)      | ❌ GONE                                                                                                                        |
| `POST /api/internal/user-board-mapping` | n/a — route deleted in W-19 (#4437)      | ❌ GONE                                                                                                                        |

### 2.5 Endpoints Staying in Next.js

| Endpoint                                 | Reason                                             |
| ---------------------------------------- | -------------------------------------------------- |
| `/api/v1/[board_name]/proxy/*`           | ❌ GONE — deleted by W-25a (#4441) + W-25b (#4443) |
| `/api/auth/*`                            | NextAuth authentication                            |
| `/api/internal/ws-auth`                  | WebSocket auth token fetch                         |
| `/api/internal/shared-sync/[board_name]` | Cron job / server-side sync                        |
| `/api/og/climb`                          | Image generation (Edge runtime)                    |

---

## Phase 3: Type Sharing (TODO)

Add new GraphQL types to `packages/shared-schema/src/schema.ts` and corresponding TypeScript types to `packages/shared-schema/src/types.ts`.

### New Types Needed

```graphql
# Board Configuration
type Grade { difficultyId: Int!, name: String! }
type Angle { angle: Int! }
type Hold { id: Int!, x: Float!, y: Float!, mirroredX: Float! }
type Image { url: String!, width: Int!, height: Int! }
type BoardDetails { holds: [Hold!]!, images: [Image!]!, ... }

# Climbs
input ClimbSearchInput { boardName: String!, layoutId: Int!, ... }
type ClimbSearchResult { climbs: [Climb!]!, totalCount: Int!, hasMore: Boolean! }
type ClimbStatsForAngle { angle: Int!, ascensionistCount: Int!, ... }
type HeatmapHold { holdId: Int!, totalUses: Int!, ... }
type SetterStats { setterId: Int!, username: String!, climbCount: Int! }
type BetaLink { link: String!, username: String!, thumbnail: String }

# Slugs
type LayoutRow { id: Int!, name: String!, ... }
type SizeRow { id: Int!, name: String!, ... }
type SetRow { id: Int!, name: String! }

# User Management
type UserProfile { id: String!, email: String!, displayName: String, avatarUrl: String }
type AuroraCredentialStatus { boardType: String!, username: String!, ... }
type Favorite { climbUuid: String!, angle: Int! }
```

---

## Phase 4: Feature Parity Testing (TODO)

### Strategy

1. Run both servers simultaneously (Next.js on 3000, backend on 8080)
2. For each migrated endpoint:
   - Call REST API, capture JSON response
   - Call GraphQL query with same parameters
   - Assert structural equality
3. Create test script for automated comparison

---

## Implementation Order

### Milestone 1: Yoga Migration ✅

- [x] Add graphql-yoga and related packages
- [x] Rewrite server.ts for pure Yoga
- [x] Implement non-GraphQL routes (health, avatars, static)
- [x] Verify WebSocket subscriptions work
- [x] Remove Express dependency

### Milestone 2: Core Queries (High Priority) ✅ PARTIAL

- [x] Add new types to shared-schema
- [x] Implement `grades`, `angles` queries (boardDetails skipped - being removed)
- [x] Implement `searchClimbs`, `climb` queries (stub implementations)
- [x] Implement `profile` query and `updateProfile` mutation
- [x] Implement `auroraCredentials` queries/mutations
- [x] Implement `favorites` query and `toggleFavorite` mutation
- [x] Add REST vs GraphQL parity tests

### Milestone 3: Supporting Queries (Medium Priority)

- [ ] Implement `climbStats`, `heatmap`, `setters` queries
- [ ] Implement slug lookup queries
- [ ] Implement `userBoardMappings` query/mutation
- [ ] Complete `searchClimbs` and `climb` with full query logic

### Milestone 4: Remaining Items (Low Priority)

- [ ] Implement `betaLinks` query
- [ ] Implement `unsyncedCounts` query
- [ ] Implement `uploadAvatar` mutation (file upload via GraphQL)

---

## Testing

```bash
# Start databases
vp run db:up

# Start backend
vp run dev:backend

# Start frontend
vp run dev

# Test health endpoint
curl http://localhost:8080/health

# Test GraphQL
curl http://localhost:8080/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ __typename }"}'
```

### Parity Tests

Removed in #4663. The REST vs GraphQL parity suite fetched the live public API
at www.boardsesh.com from a developer's machine, ran under its own vitest
config, and was excluded from CI — nothing kept it honest and it had gone
stale. Compare a resolver against its REST route by hand, or add a
fixture-backed test to the normal `backend` project.
