# Seed Contract for e2e tests

This file documents the database state every Playwright spec assumes. It is the
single source of truth for what the seeded `boardsesh-dev-db` Docker image must
provide. **Anything not listed here is fair game to break** — if a spec
implicitly depends on data outside this contract, the spec needs to either pin
the data explicitly or move the requirement into this contract.

`global-setup.ts` validates the high-level contract entries before any worker
starts and fails fast with a precise error message if a check trips.

## Test user

- **Email:** `test@boardsesh.com` (override with `TEST_USER_EMAIL`)
- **Password:** `test` (override with `TEST_USER_PASSWORD`)
- Must exist as an active, non-deleted user.
- Login via `/auth/login` must succeed and redirect to `/`.

## Default test board

The board most specs land on:

- URL: `/kilter/original/12x12-square/screw_bolt/40/list`
- Must render at least one climb row within 30 s of a cold load. Since W-15
  (#4369) that URL is a server-rendered front door, and `static-climb-row.tsx`'s
  `[data-testid="climb-thumbnail"]` is the only row marker it emits — the
  classic list's `#onboarding-climb-card` and `[data-testid="climb-card"]` are
  gone from this route. `global-setup.ts` and `helpers/waits.ts` both accept all
  three; the seeded data requirement is unchanged (≥1 listed climb with stats at
  40°).
- No onboarding-tagged rows are required any more. The queue-population flows
  that needed `#onboarding-climb-card` / `#onboarding-climb-card-2` are gone with
  the interactive list: `queue-persistence.spec.ts`,
  `play-view-swipe-close.spec.ts` and `bottom-tab-bar.spec.ts` are all deleted.

## Per-spec assumptions

| Spec                                                            | Additional data needed                                                                                                                                                                                                                                                                                                  | Status                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `bottom-tab-bar.spec.ts`                                        | Default test board contract (above). `/playlists` and `/feed` reachable for the global-setup warmup. The `Queue Integration` describe is skipped pending W-16 — it double-clicks a climb card the front door doesn't render. The `Create tab` test went with the create route in W-17.                                  | ✅                                    |
| `help-screenshots.spec.ts` (unauthenticated)                    | None — the whole describe is skipped pending W-16, which owns the `/help` rewrite and its replacement screenshots.                                                                                                                                                                                                      | ⏸️                                    |
| `help-screenshots.spec.ts` (authenticated)                      | Test user contract. Still live, and now route-independent: W-17 (#4433) removed the board header, so the `personal progress filters` shot is gone and W-16 re-homes the drawer shots. The `party mode active session` test runs off the dummy sesh mount, not a real session.                                           | ✅                                    |
| `layout-screenshots.spec.ts`                                    | One climb row (`[data-testid="climb-thumbnail"]`) on every supported Kilter/Tension layout URL, whose anchor resolves to that climb's front door — the spec follows it and shoots the board art there.                                                                                                                  | ✅                                    |
| `board-route-teardown.spec.ts`                                  | Default test board contract (above), plus `/playlists` reachable. The deleted-path redirects are config rules, so they need no seeded board on the `/b` tree; the WebSocket checks need a real climb row to follow into a climb front door.                                                                             | ✅                                    |
| `i18n-locale-routing.spec.ts`, `i18n-locale-navigation.spec.ts` | English and Spanish locale catalogs present (covered by the in-repo `packages/shared/i18n/locales/` checked into git).                                                                                                                                                                                                  | ✅                                    |
| `activity-feed-infinite-scroll.spec.ts`                         | `/feed` returns more than one page of activity items for the test user.                                                                                                                                                                                                                                                 | ⚠️ (data assumption not yet enforced) |
| `expo-web/smoke.spec.ts`                                        | Test user contract, plus at least one Kilter board bindable from the board sheet. The canonical-URL tests additionally need a board named "Dyno Den" and ≥1 listed, non-draft Kilter layout-1 climb with stats at 40° that fits size 10 and sets 1,20 — looked up at run time (lowest uuid wins), so no uuid is pinned. | ✅                                    |

## Updating the contract

When adding a new spec:

1. List the data it depends on in this file.
2. If the dependency is novel (a specific climb UUID, a specific user state),
   add a deterministic insertion to the seed script (path TBC, currently
   `packages/db/scripts/`) and bump the dev-DB Docker image version.
3. If the contract entry is broad enough that `global-setup.ts` could verify
   it cheaply, add the check there too.

The dev-DB image is rebuilt automatically when files in `packages/db/docker/`,
`packages/db/scripts/`, `packages/db/src/schema/`, `packages/db/drizzle/`, or
`packages/db/package.json` change on `main` (see CLAUDE.md → "Pre-built
database image").
