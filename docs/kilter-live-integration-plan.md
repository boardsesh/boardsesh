# Kilter Live Activity Integration Plan

**Status**: Proposed; read and contribution are separate deliverables, both disabled until their verification gates pass.
**Protocol baseline**: [KILTER_LIVE_SPEC.md](KILTER_LIVE_SPEC.md), Android 2.10.1 / build 65.
**Related docs**: [Kilter sync](kilter-sync.md), [HTTP API](KILTER_HTTP_API_SPEC.md), [PowerSync](KILTER_POWERSYNC_SPEC.md), [Bluetooth](AURORA_BLUETOOTH_PROTOCOL_SPEC.md), [board merges](board-merge-tombstones.md).

This plan adds viewing through a consenting user's own Kilter account and contribution of eligible climbs displayed during Boardsesh sessions. It does not equate recent activity with current occupancy. No feature implementation, account linking, or upstream activity write is part of this documentation change.

Protocol and repository observations use **HIGH / MEDIUM / LOW** confidence as in the spec. Proposed behavior and budgets are design decisions, not claims about Kilter's server. Unknown server behavior remains a release condition.

## Table of Contents

1. [Existing integration and risk baseline](#1-existing-integration-and-risk-baseline)
2. [Resolve physical board identity](#2-resolve-physical-board-identity)
3. [Read through the user's account](#3-read-through-the-users-account)
4. [Contribute displayed climbs](#4-contribute-displayed-climbs)
5. [Capacity, attribution, and account risk](#5-capacity-attribution-and-account-risk)
6. [Implementation sequence and acceptance gates](#6-implementation-sequence-and-acceptance-gates)

## 1. Existing integration and risk baseline

**Confidence: HIGH — repository.** `packages/kilter-sync` already contains Keycloak authentication, PowerSync snapshot ingestion, REST catalog pulls, encrypted credentials, reference mappings, and the push-back design. Reuse those responsibilities and the existing account-link model; do not introduce a second login system.

There is a material distinction in the current checkout: [`src/sync/push-back.ts`](../packages/kilter-sync/src/sync/push-back.ts) is gated by `KILTER_SYNC_PUSH_ENABLED` and its tick, rating, and circuit paths call `pushNotWired()` before any HTTP request. [`src/api/kilter-rest.ts`](../packages/kilter-sync/src/api/kilter-rest.ts) supplies typed scaffolding and transport helpers. Thus the baseline is an established account-scoped write architecture, but this checkout does **not** demonstrate operational upstream write traffic, accepted payloads, quotas, or account safety.

**Confidence: HIGH — repository.** Push-back selects user-owned rows, resolves Kilter climb aliases, and plans successful-result backfills so batches can recover from partial completion. Live `/add` has neither an observed client reference nor a decoded event acknowledgement. Its timeout ambiguity requires a different retry policy from durable logbook synchronization.

**Confidence: HIGH — protocol.** The live read plane is REST polling, while PowerSync provides reference data and has an `app_configs` table. [`powersync-client.ts`](../packages/kilter-sync/src/api/powersync-client.ts) intentionally stops at `checkpoint_complete`. Keep that snapshot behavior; do not convert the existing sync daemon into an unbounded live-feed subscriber or invent an activity stream.

## 2. Resolve physical board identity

### Available keys

**Confidence: HIGH — repository**, except the stated coverage estimate.

| Side | Keys available | What they can establish |
| --- | --- | --- |
| Kilter references | Wall `wallUuid`/`id`, `gymUuid`, `productLayoutUuid`, product name, serial, hold-set mask, angle/configuration, name and listing state | Source wall and compatible configuration |
| Boardsesh board | `user_boards.uuid` and numeric ID; board type, layout, size, sets, gym, nullable serial, `mergedIntoBoardUuid` | Boardsesh identity and canonical survivor |
| Imported location | Source key `kilter:<gymUuid>:<wallUuid-or-id>`; deterministic board UUID from that key | Exact source-wall candidate without a serial |
| Gym source mapping | `location_sync_gym_sources.source_key = kilter:<gymUuid>` | External gym association; not a unique wall within it |
| Per-user serial memory | `user_board_serials`: user, board name, serial, configuration and optional `boardUuid` | User's previous disambiguation of a controller |
| Current session/report | Session ID, stable participant ID, confirmed climb, board record, optional connection serial | Session state and emitting actor; not an external wall ID |

The user-provided estimate is that roughly **79% of board rows lack a serial**; it was not remeasured for this work. Serial matching cannot be the default join.

**Confidence: HIGH — repository.** [`locations-sync.ts`](../packages/kilter-sync/src/sync/locations-sync.ts) builds the Kilter source key; [`boardUuidForSource`](../packages/location-sync/src/ids.ts) hashes it deterministically. The wall source key is not stored verbatim on `user_boards`, so reconstruct it from reference enumeration and compare the resulting UUID. Use the shared function rather than reproducing its hash formatting. Kilter layout aliases can be many-to-one and may contain small-integer strings despite the `Uuid` field name; preserve source IDs as opaque strings.

### Join options and checkable conditions

Each option has a client condition checkable against the binary and a separate server gate. A client passing a selector does not prove the server's interpretation of it.

| Option | What must be true in the protocol | Evidence/status | Proposed use |
| --- | --- | --- | --- |
| Reconstruct imported identity | Feed requests carry the same wall/gym/layout identifiers exposed by wall references; reads do not require serial | HIGH: read body has those selectors and no serial. LOW: exact server matching still needs verification | Preferred candidate: enumerate source walls, derive board UUID, follow merge chain, compare current configuration |
| User confirms a Kilter wall | A selected reference `wallUuid` can be sent with its gym/layout without requiring a proprietary hardware lookup first | HIGH: official read path does this. LOW: account visibility and mismatched-selector behavior | For manually created boards, offer compatible walls at the associated gym; persist an explicit user binding |
| Serial corroborates a candidate | Connection serial can be associated with a wall; `/add` accepts that serial alongside wall/gym/layout | HIGH: publisher includes serial. LOW: serial uniqueness and server validation | Normalize for comparison and require board type/config plus user disambiguation; never auto-merge solely on serial |
| Serial-less gym contribution | Publisher has a branch using `serialNumber: null`, known wall/gym/layout, and local location eligibility | HIGH: observed 200 m branch. LOW: server acceptance | Enable only after controlled verification; require consent to location and current eligibility |
| Custom/home-wall binding | Account-specific wall ID/layout and serial can be used; custom `gymUuid` is the token's `sub` | HIGH: custom client branch. LOW: server visibility and stability | Separate account-scoped binding; defer initial contribution until custom-wall behavior is verified |
| Infer wall from configuration or proximity alone | Protocol would need a unique physical-wall resolver from layout/sets/angle or location | LOW: no such resolver established | Suggestions only; never commit a binding or publish from this inference |

### Binding storage and merge behavior

Propose a dedicated binding relation in `packages/db`, exposed through backend GraphQL. Store canonical Boardsesh board UUID, Kilter wall/gym/layout IDs, scope (`gym` or `custom`), linked Kilter account for private/manual bindings, evidence kind (`import` / `user-confirmed` / `serial-corroborated`), source board UUID, confirmation actor/time, and mapping revision. Store read enablement and contribution consent separately from mapping evidence. Do not write a Kilter wall ID into Boardsesh's serial field.

Use at most one active binding per account and canonical board. Imported public candidates may be shared as reference metadata; custom-wall bindings and manual confirmations remain account scoped. Revalidate the linked account, source visibility, configuration and mapping revision whenever enabling contribution. Never combine multiple upstream wall feeds silently because duplicate Boardsesh rows merged.

**Confidence: HIGH — repository.** [`followBoardMergeChain`](../packages/backend/src/graphql/resolvers/board-presence/shared.ts) follows at most three links; a plain deletion, dangling target, or excessive chain does not resolve. Its callers enforce access to the survivor. Apply the same canonicalization and access checks before reading a binding, storing it, or publishing. Preserve source provenance across merges; conflicting upstream IDs disable contribution and require a new wall confirmation. A changed board configuration or gym also invalidates prior write eligibility.

**Confidence: HIGH — repository.** [`user_board_serials`](../packages/db/src/schema/app/board-serials.ts) is unique per `(userId, boardName, serialNumber)`, not globally. Existing resolution trims and uppercases serials and considers board/configuration preferences. Keep original connection serial separately for the outgoing protocol representation; do not assume backend normalization is Kilter's normalization. Multiple candidates require explicit selection.

**Confidence: HIGH — protocol.** Kilter's live publisher takes its connection serial from the Bluetooth candidate's `Name#serial@version` suffix, with both delimiters required; it does not fill a missing serial from the selected wall's saved metadata. See [serial acquisition](KILTER_LIVE_SPEC.md#44-where-the-serial-comes-from). A bare-name Kilter controller therefore follows the serial-less gym branch even if a board record contains a manually entered serial. Preserve that distinction in eligibility evidence. Whether newer Kilter-built hardware has resumed serial advertising remains **LOW confidence / unresolved**; do not base coverage estimates or custom-wall support on that assumption.

## 3. Read through the user's account

Proposed ownership:

- `packages/kilter-sync`: a small live REST client using existing host/auth/error conventions, with strict response parsing and explicit freshness/error results.
- `packages/backend`: GraphQL queries/subscriptions, account and board authorization, binding resolution, poll ownership, limits, and credential access.
- `packages/shared/kilter-live`: pure event types, selector normalization, response projection, freshness rules and publish eligibility shared by platforms. Inject time and platform I/O; no duplicated web/mobile business logic.
- `packages/mobile`: the activity view and separate consent controls, using shared logic. Any later browser surface uses the same backend and shared package.

Read flow:

1. The signed-in Boardsesh user enables viewing for their own linked Kilter account and confirms a wall binding when no exact imported binding is available.
2. Backend resolves the canonical board, checks user access and binding scope, and obtains credentials through the existing encrypted account store. Coordinate refresh-token rotation with the sync daemon using a per-account lease and persisted replacement tokens; concurrent workers must not race rotating credentials.
3. Backend calls `/climbs` with the three verified selectors. Share an in-flight request only within the same account and complete selector tuple. Do not serve one user's authenticated response to unrelated users.
4. While a foreground viewer exists, schedule at the configured interval, with **30 seconds as the initial minimum** and jitter that only lengthens it. Stop when the last authorized viewer disconnects; recheck consent on reconnect. Add `app_configs` ingestion only after identifying its existing stream; no global wall crawl for activity.
5. Return recent entries, `fetchedAt`, `lastSuccessfulFetchAt`, source label, and an explicit stale/error state. Use the upstream event ID when present and preserve repeated display semantics; a UI projection may follow Kilter's climb-plus-angle deduplication. Keep data ephemeral and account scoped; invalidate on unlink, consent withdrawal, or binding change.

Show “Recently displayed” and its timestamp. Never replace Boardsesh's confirmed on-wall state, declare a wall empty from a failed read, infer occupants, auto-join a session, or light a climb merely because a feed entry arrived. Do not link `liveBoardUsername` to a Boardsesh profile by name. Treat normal climb setter metadata and the live actor label as distinct fields.

**Release conditions:** verify one authorized response including null/malformed optional fields, confirm wall scoping with two distinct wall selections, establish visibility restrictions, and resolve read-use terms with Kilter. Public or account-independent caching remains disabled unless an explicit public contract is established. New activity/session routes default to `noindex, follow`; no public SEO route is needed for the initial feature.

## 4. Contribute displayed climbs

### Trigger and actor

**Confidence: HIGH — repository.** [`confirmClimbOnWall`](../packages/backend/src/graphql/resolvers/sessions/mutations.ts) validates stable participant membership and recent queue history, then records the session confirmation. It is not an external wall identity or proof of physical display. [`reportBoardClimb`](../packages/backend/src/graphql/resolvers/board-presence/mutations.ts) already accepts display reports, resolves the emitting actor, checks board membership and catalog compatibility, and tracks current writer, deduplication and durable activity. Its membership check accepts a selected board, so it is not physical attestation either.

Use the successful device-write report behind `reportBoardClimb` as the contribution candidate, and require an authenticated actor with their own Kilter link and explicit contribution consent. Add a current connection lease/proof record to the candidate contract if the existing report cannot distinguish actual device writes from selection-only clients. A session host's account must never announce all participants' activity. Anonymous emitters, accountless controllers, kiosk browsing, queue selection, failed device writes and imported live-feed events are ineligible.

### Proposed contribution lifecycle

1. Capture canonical board and binding revision, actor/account ID, actual controller/device context, Kilter climb ID, integer angle, display sequence, successful-write time, and eligibility evidence. Resolve Kilter climb aliases in one batch, as push-back does; require proven Kilter catalog membership when no alias exists. Skip Boardsesh-only climbs instead of guessing that a canonical UUID is accepted upstream.
2. Maintain one pending candidate per active controller/actor. Use the configured append delay with **45 seconds as the initial minimum**, replacing pending work when the displayed climb or angle changes. Require the display sequence, controller lease, account, consent, binding revision and current writer to remain valid at dispatch. Disconnect, logout, unlink, handoff and mapping changes cancel pending work.
3. For a gym wall, require the connection serial or a recent, consented location check within 200 m of the mapped gym, following the observed client alternatives. Validate that location evidence is fresh and belongs to the emitting device; keep it short-lived and out of logs. A backend request alone cannot prove physical proximity. Do not fabricate serials or coordinates to pass this gate.
4. Serialize the verified eight fields, including `userUuid: null` and `createdAt: null`, and use the actor's token. The server must first be verified to attribute this correctly. Do not add arbitrary session IDs, spoof another username, or append a Boardsesh brand suffix to a real account's identity.
5. Persist local delivery state (`pending`, `sending`, `accepted`, `unknown`, `cancelled`, `failed`) with a unique local display-event key, short expiry and worker lease. Status 200 means the observed client success condition, not proven exactly-once delivery. A timeout after send becomes `unknown`; do not automatically replay ambiguous POSTs until upstream idempotency is established. Expired/offline activity must not be backfilled as if current.

The local deduplication key includes account, canonical wall binding/revision, controller lease and display sequence. Reconnects must retain the same logical event identifier; a new genuine display can publish later. This prevents Boardsesh worker retries and duplicate device reports, but cannot suppress a simultaneous event from Kilter's app without upstream support.

Contribute only display events supported by this protocol. Ending a Boardsesh session stops future contributions and cancels pending work; it does not call `/report`, manufacture a leave event, or promise removal of an already accepted entry. Read and write flags remain independently switchable.

**Release conditions:** controlled observation of accepted serial and serial-less events, identity and timestamp attribution, duplicate/timeout behavior, and agreed account-risk controls. Custom-wall contributions additionally require verification of token-sub-as-gym semantics and private visibility. Any implementation touching BLE code receives the required Fable/Astra review before merge.

## 5. Capacity, attribution, and account risk

### Sizing

These are proposed capacity estimates, **not Kilter quotas**. Let `R` be active account/selector pollers after same-account coalescing and `W` active contributing controllers. With the observed defaults, steady read traffic is approximately `R / 30` requests/second; a sustained scenario where each controller produces an eligible event every 45 seconds is `W / 45` writes/second. Actual request durations reduce polling frequency; initial loads, reconnects and retries add traffic.

| Active read pollers / contributing controllers | Read requests/second | Sustained write scenario/second |
| --- | --- | --- |
| 100 / 100 | 3.3 | 2.2 |
| 1,000 / 1,000 | 33.3 | 22.2 |
| 10,000 / 10,000 | 333.3 | 222.2 |

One continuously active viewer at 30 seconds is about 120 reads/hour. One controller publishing every 45 seconds is about 80 writes/hour. This is substantially different from sporadic logbook changes, even with the same user token. Do not apply Boardsesh's existing `reportBoardClimb` allowance (60/minute per signed-in user) as an upstream quota.

Propose an allowlisted pilot of **at most five accounts**, one selected wall per account, read cap **1 request/second globally**, write cap **1 request/5 seconds globally**, and per-account minimum intervals of 30/45 seconds. Apply global limits across backend instances using Redis; count initial loads, refresh attempts and retries. Expire pending work rather than draining a stale queue. These are conservative starting budgets requiring Kilter agreement, not a claim they are safe production limits. Increase only against explicit quotas and measured traffic.

Use bounded timeouts, single-flight reads, positive jitter, and exponential backoff for safe reads. Respect `Retry-After` when supplied; on 429 pause the affected scope and reduce the global budget if scope is unknown. A 401 allows one coordinated refresh; repeated 401, any unexplained 403, or changed response schema pauses the account. Ambiguous writes are not blindly retried. Track counts, status, latency, backoff, mapping confidence and local delivery state without logging tokens, raw coordinates or response usernames.

### Attribution, terms, and account flags

**Confidence: HIGH — published terms; LOW — application/enforcement to this integration.** Kilter's terms, last updated March 9, 2026, restrict alternate interfaces, automated copying and non-personal/commercial use (§1), make account holders responsible for account activity (§2), restrict reverse engineering subject to stated exceptions (§5), and permit suspension and changing service limits (§§1, 6). Those provisions create concrete exposure for this integration and its users; consent to link an account does not itself resolve that exposure. Applicability and any interoperability exceptions need assessment, not an assumption of permission. [Kilter Terms of Use](https://app.kiltergrips.com/terms).

Propose discussing both read access and contribution with Kilter before production rollout, using the protocol spec with its provenance intact. Obtain an agreed client identity, quota scopes, supported attribution, visibility/opt-out rules, idempotency behavior, and an escalation contact for account flags. This plan does not send that outreach.

Explain contribution separately from read consent: eligible climbs may appear under the user's Kilter identity, with the mapped wall, angle and time; upstream visibility and deletion must be confirmed before making promises. Let users stop future contribution without disabling reading or existing account sync. Technical compatibility must never imply endorsement by Kilter or Aurora.

**Confidence: LOW — risk probability.** The likelihood of flags is unknown. Centralized server egress, many account tokens, publication bursts, wrong wall attribution, and duplicate events are plausible flagging or moderation triggers, not observed detection rules. Monitor account failures and reports during the pilot; stop the affected scope and offer relinking only after diagnosis. Do not rotate accounts/IPs, spoof the official client, or retry through a restriction. Existing push-back scaffolding provides no measured reassurance about this risk.

## 6. Implementation sequence and acceptance gates

| Phase | Deliverable | Exit evidence |
| --- | --- | --- |
| 0. Protocol agreement and fixtures | Resolve prioritized open questions with Kilter; obtain minimal consented read/write observations | Confirm wall scoping, actor identity, timestamps, serial-less acceptance, quotas and permitted use; retain redacted fixtures |
| 1. Mapping and shared contract | Pure types/parsers/eligibility in `packages/shared/kilter-live`; binding schema generated through Drizzle; backend binding resolvers | Imported serial-less join; manual ambiguity; opaque/many-to-one layout aliases; serial collisions; merge and private-survivor tests |
| 2. Read pilot | Live REST reader, coordinated credentials, backend poll ownership, mobile activity view and read consent | Two-wall separation, account-cache isolation, expiry/stale UI, refresh rotation race, disconnect cleanup, and rate-limit tests |
| 3. Contribution preparation | Separate opt-in, real-device-write candidate, debounce/cancellation, delivery ledger and global budget | Dry-run shows correct wall, actor, alias and angle; no network publication; reconnect/handoff/merge/offline cases pass |
| 4. Contribution pilot | Enable serial-equipped gym writes, then verified serial-less branch, each behind separate allowlists | Controlled upstream result matches physical display and intended account; no duplicates, stale replay, or account restrictions; emergency disable exercised |
| 5. Broader compatibility | Expand only within agreed budgets; consider custom walls after their additional gates | Measured load within quotas; privacy, reporting and operational support agreed |

Implementation QA must cover two phones sharing a session, one user's multiple devices, a controller without a linked account, no-serial boards, denied/stale location, two identical configurations at one gym, a merged/deleted/private board, wrong climb aliases, and disconnect or consent withdrawal during the debounce. Assert that feed reads never trigger contribution and that failed reads never alter confirmed on-wall state.

Use `vp check` and `vp run typecheck` for each implementation PR, plus meaningful package tests. Mobile changes also follow the repo's mobile test/bundle/simulator sequence. This documentation PR needs the canonical checks and documentation review; no behavior-mirroring tests are added for Markdown.

The first implementation decision is the mapping/read contract. Contribution remains a planned deliverable with explicit upstream gates; it must not disappear from scope or be enabled merely because reading works.
