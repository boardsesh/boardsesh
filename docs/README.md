# Boardsesh documentation

Start with the topic below, then follow its **Start here** guides. Source code,
schemas and configuration define current behavior; documents explain contracts,
tradeoffs and operating procedures.

| Topic | What to find |
| --- | --- |
| [Authentication and identity](auth/README.md) | Released authentication behavior, staged Better Auth contracts, compatibility requirements and activation gates. |
| [Backend services](backend/README.md) | GraphQL and WebSocket services, background jobs, scheduling, email and structured logs. |
| [Boards and hardware](boards/README.md) | Board protocols, connection ownership, LED controllers and firmware. Protocol evidence states its device and app coverage. |
| [Data and offline sync](data/README.md) | Entity relationships, catalog ingestion, local SQLite, snapshot bootstrap, sync contracts and climbing statistics. |
| [Design system](design/README.md) | Velvet Send tokens, shared components, accessibility, native chrome, motion and maintained design previews. |
| [Integrations and external APIs](integrations/README.md) | The partner developer contract, internal integration architecture, local training tools and upstream protocol references. |
| [Mobile app](mobile/README.md) | Expo app architecture, current screen behavior, navigation and performance. Shared visual rules live in the design topic. |
| [Climbing behavior](product/README.md) | Queue and player behavior, playlists, sessions, workouts, spray walls, privacy and manufacturing packs. |
| [Board rendering](rendering/README.md) | Board art geometry, GPU and WASM paths, rendering experiments and measurements that support active qualification. |
| [Operations and delivery](operations/README.md) | Deployment, releases, hosting configuration, database operations, storage, disaster recovery and CI. Read each runbook’s gates before applying it. |
| [Testing and qualification](qa/README.md) | Local and device testing, screenshot fixtures, CI gates and retained records of outstanding acceptance work. |
| [Website and SEO](web/README.md) | The public SSR website, app handoffs, indexation, canonical URLs, gym search, Open Graph images and [supported-board gallery evidence](www-refresh/boards-readability.md). |
| [Marketing and instructional media](marketing/README.md) | Store creatives, screenshots, help videos and repeatable capture and publication workflows. |
| [Analytics and telemetry](analytics/README.md) | Consent, event contracts, growth measurements, error telemetry and feedback intake. |
| [Translations](i18n/README.md) | Shared terminology and translation editing. Consult the target language glossary before changing copy. |

## Keeping documentation useful

1. Put a document under its owning topic and link it from that topic’s index.
2. Keep one authoritative contract; link to source schemas instead of copying them.
3. Keep assets and machine-readable inputs beside the topic that owns them.
4. Distinguish shipped behavior, staged changes and outstanding acceptance work.
5. Retire completed handovers and superseded instructions after preserving useful requirements.

Retain measurements when they support an active decision or unresolved acceptance
gate. Include their source revision, controls and limitations. Git history retains
removed plans and obsolete captures; a general archive folder is unnecessary.

Run `vp run check:docs` after changing documentation or its paths. Scripts and CI
consume some files here, including token tables, release documentation, manifests
and LED map source data; update those consumers in the same change.

Applied SQL migrations, historical SQLite migration definitions and released-client
source recordings retain their recorded bytes. Their original documentation
references are historical provenance: preserve them when moving current guides.
The documentation checker excludes these artifacts; migration and released-client
provenance tests verify them separately.

The OTA boot checker, shared helper and workflow keep their existing verification inputs.
Their three historical guide references are explicitly mapped to the current OTA
runbook by the documentation checker, which still validates that destination.
