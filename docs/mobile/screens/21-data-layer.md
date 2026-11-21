# Mobile data-layer entry points

The mobile app has implemented profiles, feeds, notifications, settings, logbook,
authoring, and shared sessions. The original rewrite gap checklist is obsolete;
inspect the current route and hooks when assessing feature coverage.

| Responsibility | Source of truth |
| --- | --- |
| GraphQL operations and wire types | `packages/shared/graphql/`, `packages/shared-schema/` |
| Native/browser GraphQL transport | `packages/mobile/src/lib/graphql/` platform client forks |
| Screen query hooks | `packages/mobile/src/lib/graphql/hooks/` and domain-specific shared React packages |
| Authentication and account transitions | `packages/mobile/src/providers/auth-provider.tsx` |
| Queue commands, persistence, realtime | `packages/mobile/src/providers/queue/`, `@boardsesh/queue` |
| Board and tick behavior | `@boardsesh/board-react`, injected mobile adapters |
| Offline persistence and synchronization | `@boardsesh/offline-sync`, `packages/mobile/src/offline/offline-sync-adapter.ts` |
| General app preferences | `packages/mobile/src/settings/` |

Screens compose existing domain hooks. Platform-free business logic belongs in
shared packages; shared React packages cannot import native/DOM host APIs. Backend
behavior belongs in `packages/backend`, not a new Next.js proxy.

Read [offline reads](../../data/offline-reads.md), [offline sync](../../data/offline-sync.md),
[sync manifest](../../data/sync-table-manifest.md), and [WebSocket architecture](../../backend/websocket-implementation.md)
for authoritative scope, schema, and delivery contracts. Browser credentials and
native secure storage have different contracts; neither belongs in the generic
preferences store.
