# Mobile profiles

The You/Profile stack is under `packages/mobile/app/(tabs)/profile/`. Shared public
profile routes under `app/users/[userId]/` are also exported inside the tab stacks
so Back returns to the caller's screen.

The implementation lives under `packages/mobile/src/components/you/`: profile
header and board overview, sessions, logbook, authored climbs, beta, connections,
and their filters. Profile statistics use the renderer-independent aggregation
and view models in `@boardsesh/profile-stats`.

Respect the difference between the signed-in account and a viewed public user.
Follow requests, visibility, and available actions are enforced by shared/backend
contracts, not inferred from a profile being reachable. Account-only edits and
settings belong to the account/settings stack.

See [logbook](19-logbook.md) for filters and tick actions,
[privacy](../../product/privacy.md) for public/account visibility, and
[mobile chrome](../../design/mobile-chrome.md) for the header and tab surfaces. Website
`/crusher/` and `/setter/` pages retain their own SSR and metadata requirements;
the old web `/you` dashboard is not the mobile screen specification.
