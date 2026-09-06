# Kilter Live Board Activity Specification

**Covered version**: Kilter Board Android 2.10.1, versionCode 65 (`com.kiltergrips.kilter_board_app`)
**Re-verified**: 2026-09-07 against the Google Play APK installed on the connected Android phone, using readable Dart AOT strings and call-path analysis of `libapp.so` (SHA-256 `f5191fdbf466cf2082a9ae5e076c43cf69d13e6b5ca9aeca3eebb79f9222eeed`; 30,922 strings at minimum length 5).
**Sibling docs**: [HTTP API](KILTER_HTTP_API_SPEC.md), [PowerSync](KILTER_POWERSYNC_SPEC.md), [Bluetooth](AURORA_BLUETOOTH_PROTOCOL_SPEC.md), [Kilter sync](kilter-sync.md), [integration plan](kilter-live-integration-plan.md)

> The live feature reads recently displayed climbs through authenticated REST polling and publishes display events through a separate REST endpoint. Its observed contract is a wall-scoped recent-climb feed. A feed entry does not establish that a climber is still present or that a climb is still lit.
>
> Confidence markers apply to client behavior: **HIGH** means a literal, serializer, or call path establishes the claim; **MEDIUM** means the client supports an interpretation whose server semantics remain unverified; **LOW** means unresolved. No authenticated live responses or production writes were exercised. Android and iOS version numbers are independent; this document makes no claim of iOS protocol parity.

---

## Table of Contents

1. [Transport and new surface](#1-transport-and-new-surface)
2. [Identity and event semantics](#2-identity-and-event-semantics)
3. [Read: recently displayed climbs](#3-read-recently-displayed-climbs)
4. [Write: publish a displayed climb](#4-write-publish-a-displayed-climb)
5. [Moderation](#5-moderation)
6. [Configuration and timing](#6-configuration-and-timing)
7. [Authentication, attribution, and privacy](#7-authentication-attribution-and-privacy)
8. [Open questions](#8-open-questions)
9. [Verification anchors](#9-verification-anchors)

---

## 1. Transport and new surface

**Confidence: HIGH.** These paths extend the inventory in [KILTER_HTTP_API_SPEC.md](KILTER_HTTP_API_SPEC.md). All three call `package:http`'s `post`; the read operation is also a POST.

| Method | Host and path | Role |
| --- | --- | --- |
| POST | `https://portal.kiltergrips.com/api/recently-displayed-climbs/climbs` | Read recent climbs for a wall selection |
| POST | `https://portal.kiltergrips.com/api/recently-displayed-climbs/add` | Publish a displayed climb |
| POST | `https://portal.kiltergrips.com/api/recently-displayed-climbs/report` | Report an existing feed entry |

**Confidence: HIGH.** The traced activity paths use the existing portal host and Keycloak bearer token. They do not call PowerSync CRUD upload, a live-specific stream subscription, WebSocket, or SSE. PowerSync's client schema additionally contains `app_configs`, which supplies timing settings (§6). No new activity hostname or activity stream-subscription name is established by these paths. Existing identity and reference-sync hosts remain documented in the sibling specs.

**Confidence: MEDIUM.** “Live” describes periodically refreshed recent display history. There is no session lease, heartbeat, occupancy count, or disconnect event in the observed request schemas. This does not exclude an undiscovered server facility.

## 2. Identity and event semantics

**Confidence: HIGH** for keys and their client uses; server matching rules are **LOW** confidence.

| Identifier | Observed role | Boundary |
| --- | --- | --- |
| `gymUuid` | Read selector; gym scope on normal-wall writes | Custom-wall writes use the signed-in token's `sub` in this field (§4) |
| `productLayoutUuid` | Read selector and published layout | A layout describes a configuration, not a unique physical installation |
| `wallUuid` | Read selector and published wall reference | Obtained from the selected wall; not a Bluetooth address |
| `serialNumber` | Optional published controller serial | Absent from the read body; serial-less gym writes have a local proximity gate |
| `climbUuid` | Published climb identifier; returned climb identity | Identifies the climb, not a particular display event |
| `recentlyDisplayedClimbId` | Returned numeric event identifier; moderation target | Distinct from `climbUuid` |
| JWT `sub` | Signed-in account identifier in the client | Separate from Boardsesh user and participant IDs |
| `liveBoardUsername` | Nullable read-side identity label specific to this feature | Not a stable account-join key; anonymity semantics unverified |

**Confidence: HIGH.** Publication includes an integer angle, but no Boardsesh-style session ID, queue-item ID, participant ID, duration, or client event ID. The ordinary climb-detail parser also reads `userUuid` and `username`; these must not be assumed to identify the person who displayed the climb simply because they occur in a live response. The live-specific field is `liveBoardUsername`.

## 3. Read: recently displayed climbs

### 3.1 Request

**Confidence: HIGH.** `ClimbService.fetchRecentlyDisplayedClimbs` sends the following schema. Placeholder strings below illustrate field positions, not a tested request:

```http
POST /api/recently-displayed-climbs/climbs
Host: portal.kiltergrips.com
Authorization: Bearer <access_token>
Content-Type: application/json
Accept-Encoding: gzip
```

```json
{
  "gymUuid": "<kilter-gym-id>",
  "productLayoutUuid": "<kilter-layout-id>",
  "wallUuid": "<kilter-wall-id>"
}
```

**Confidence: HIGH.** The map permits nullable strings and serializes all three keys. It includes no serial, angle, timestamp cursor, page size, or user ID. Nullable client types do not establish that omitting a selector or sending null returns a broader/public feed.

### 3.2 Response

**Confidence: HIGH.** The client accepts status **200**, decodes the body as UTF-8 JSON, and expects a top-level iterable of climb-detail objects (a JSON array), rather than a `{data: ...}` envelope. It filters entries with `isDeleted == true` and uses `Climb.climbDetailFromJson` for the remaining entries.

The following is the live-relevant subset of that parser, **not** a complete response fixture:

| Field | Client interpretation | Confidence |
| --- | --- | --- |
| `climbUuid` | String climb identifier | HIGH |
| `angle` | Nullable number converted to an integer | HIGH |
| `derivativeAngle` | Nullable number converted to an integer; preferred over `angle` for feed deduplication | HIGH |
| `recentlyDisplayedAt` | Nullable string passed to `DateTime.tryParse`; invalid date becomes null | HIGH |
| `recentlyDisplayedClimbId` | Nullable number converted to an integer | HIGH |
| `recentlyDisplayedReported` | Nullable Boolean, default false | HIGH |
| `liveBoardUsername` | Nullable string | HIGH |

**Confidence: HIGH.** The client deduplicates by `climbUuid` plus `(derivativeAngle ?? angle ?? 0)`, keeps the entry with the newer `recentlyDisplayedAt`, and sorts descending by that timestamp with null timestamps last. The visible list therefore need not represent every individual display or every climber.

**Confidence: LOW.** Retention window, maximum response size, timestamp timezone/clock source, server ordering, and whether the returned angle always equals the submitted display angle remain unverified. Ordinary climb `createdAt` is distinct from `recentlyDisplayedAt`.

### 3.3 Refresh and failures

**Confidence: HIGH.** The live screen preloads the list, then uses a one-shot timer which reloads and schedules another timer after completion. The default delay is 30 seconds (§6); request duration adds to that delay. Disposal cancels the screen's timer.

**Confidence: HIGH.** A non-200 response in the service returns its prior in-memory list, or an empty list if there is no cached result. This is not evidence of an empty wall or fresh data. The memory key uses gym, layout, and a third caller-supplied selector; the separately supplied `wallUuid` and bearer token are not incorporated by that key function. A new integration should scope caches explicitly to both account and complete wall selection.

**Confidence: LOW.** No live-endpoint quota, `Retry-After` contract, or documented error response schema is established. The inspected service does not provide an HTTP-level freshness guarantee.

## 4. Write: publish a displayed climb

### 4.1 Request and result

**Confidence: HIGH.** `ClimbService.addRecentlyDisplayedClimb` sends bearer authorization and JSON to `/api/recently-displayed-climbs/add`. `RecentlyDisplayedClimb.toJson` emits exactly these eight keys:

```json
{
  "gymUuid": "<kilter-gym-id>",
  "productLayoutUuid": "<kilter-layout-id>",
  "serialNumber": "<controller-serial>",
  "userUuid": null,
  "climbUuid": "<kilter-climb-id>",
  "angle": 40,
  "createdAt": null,
  "wallUuid": "<kilter-wall-id>"
}
```

**Confidence: HIGH.** In the traced publisher, `serialNumber` is the trimmed connection-associated serial or JSON null. `userUuid` is left unset and serializes as null; `createdAt` is explicitly serialized as null. The example angle is illustrative. No coordinates are transmitted in this body.

**Confidence: HIGH.** The method returns whether the status is exactly 200. It does not decode an assigned event ID or a per-item acknowledgement. The caller awaits this Boolean without using it and catches failures. No persistent outbox, client reference, or idempotency key is present in this path.

**Confidence: MEDIUM.** Null identity and creation time suggest that the server supplies attribution and event time. The binary cannot establish that the server binds attribution to the token, rejects alternate `userUuid` values, or deduplicates retries.

### 4.2 Publication eligibility

**Confidence: HIGH.** `_writePendingClimbFrames` awaits the Bluetooth provider's `writeData` before calling `_queueRecentlyDisplayedClimb`. This is a client write-completion path, not hardware acknowledgement that the holds are visibly correct.

**Confidence: HIGH.** Scheduling requires a nonempty access token and account `sub`, a connected Bluetooth device with a nonempty device identifier, and a nonempty selected wall reference. The wall reference comes from the climb-detail selection or the active-board provider. The event captures the climb and angle and uses the wall's layout, falling back to the captured layout if the wall layout is empty.

| Wall path | Client eligibility and body scope | Confidence |
| --- | --- | --- |
| Normal gym wall, serial available | Requires nonempty gym and layout; sends wall's gym ID and trimmed serial | HIGH |
| Normal gym wall, no serial | Requires location and gym coordinates; distance must be at most **200 metres**; sends wall's gym ID and `serialNumber: null` | HIGH |
| Custom-wall path | Requires a nonempty serial; sends the current account's JWT `sub` as **`gymUuid`**, with selected `wallUuid` and layout | HIGH |

**Confidence: HIGH.** The proximity check happens locally through `Geolocator.distanceBetween`; coordinates are not added to the published model. The custom-wall screen sets the branch flag responsible for the serial requirement and account-scoped `gymUuid`. Its downstream server lookup and privacy rules are **LOW** confidence. A custom wall must not be treated as a normal public gym solely because this field is named `gymUuid`.

### 4.3 Debounce and cancellation

**Confidence: HIGH.** A shared `RecentlyDisplayedDebounceService` holds one pending timer. The publisher supplies a key composed of wall reference, captured layout, climb UUID, angle, and serial-or-empty, plus the configurable delay (default 45 seconds). Matching pending work is suppressed; replacement work cancels the earlier timer. Timer expiry clears pending state and evaluates an eligibility predicate before invoking the publisher.

**Confidence: HIGH.** The predicate requires the same connected Bluetooth device, a nonempty token, and the same account `sub`. The async publisher checks the connection/device and token again after its wall/gym/location work. The observed checks are client eligibility rules, not server-verifiable proof of location or board ownership.

**Confidence: LOW.** There is no established upstream disconnect/clear operation, guaranteed one-entry-per-climb behavior across installations, or acknowledged retry protocol. A changed or disconnected Boardsesh session cannot be translated into a fabricated upstream leave event.

## 5. Moderation

**Confidence: HIGH.** The live screen's `_confirmAndReport` flow calls `reportRecentlyDisplayedClimb`, which sends bearer authorization and JSON:

```http
POST /api/recently-displayed-climbs/report
Host: portal.kiltergrips.com
Content-Type: application/json
Authorization: Bearer <access_token>
```

```json
{ "recentlyDisplayedClimbId": 123 }
```

**Confidence: HIGH.** The numeric value is an illustrative event ID. The client treats status 200 as success. This endpoint reports an existing entry; it does not contribute activity. The response parser's `recentlyDisplayedReported` flag is not an opt-out setting.

**Confidence: LOW.** Whether reporting hides an entry for one viewer, hides it globally, or sends it for review is unverified. Deletion, report reversal, and moderation thresholds are also unverified.

## 6. Configuration and timing

**Confidence: HIGH.** The PowerSync client `Schema` contains an `app_configs` table with these integer columns. `AppProvider` watches the first row using the query below and applies positive-integer defaults:

```sql
SELECT live_climbs_pool_interval, live_climbs_append_debounce
FROM app_configs
LIMIT 1
```

| Column | Meaning in client | Default |
| --- | --- | --- |
| `live_climbs_pool_interval` | Delay in seconds between completed live loads and the next poll | 30 |
| `live_climbs_append_debounce` | Delay in seconds before pending publication | 45 |

**Confidence: HIGH.** `pool` is the literal spelling of the first key. The table carries configuration, while the traced feed carries activity through REST. **Confidence: LOW** for which named server stream delivers `app_configs` and its current production values. Do not invent a `live`, `presence`, or `recently_displayed_climbs` stream from the feature name.

## 7. Authentication, attribution, and privacy

| Question | Observed answer | Confidence |
| --- | --- | --- |
| Does the official read path sign in? | It requires a non-null access token and sends it as a bearer token | HIGH |
| Do publish and report send auth? | Both use bearer authorization; publication also checks account `sub` | HIGH |
| Is any live endpoint public? | No unauthenticated live path is established; server behavior without a token is unknown | LOW |
| Who is announced? | Write body carries null `userUuid`; read parser has nullable `liveBoardUsername` | HIGH |
| Does the token determine the announced user? | Likely, but server attribution/enforcement is unverified | MEDIUM |
| Can users hide their identity or opt out? | No live-specific privacy field or preference check was found in the traced publication path or inspected user-settings model | HIGH for that observation; LOW for availability elsewhere |
| Does a null username mean anonymous participation? | The parser permits null; its cause and meaning are unverified | LOW |
| Are sessions or other climbers announced together? | No such fields occur in the observed publish serializer | HIGH |

**Confidence: LOW.** Account linkage, visibility to strangers, custom-wall access restrictions, retention of identities, and deletion rights cannot be established from this client alone. A recent username must not be equated with a currently present person or mapped automatically onto a Boardsesh account.

## 8. Open questions

All items below are **LOW confidence / unresolved**, unless an explicit client observation above narrows the question:

1. Server validation and selector precedence for gym, layout, wall, serial, and null selectors; wall visibility and account ownership checks.
2. Whether custom-wall account-scoped gym IDs and wall references are stable across devices and visible only to their owner.
3. Accepted write shapes in practice, serial-less write acceptance, and whether the server applies additional physical-presence checks.
4. Attribution to token `sub`, generation of `liveBoardUsername`, anonymity/opt-out controls, and identity retention.
5. Full response examples, event retention, limits, timezones, and display-angle semantics.
6. Idempotency, duplicate submission handling, response bodies, timeout ambiguity, quotas, and account/IP/client rate-limit scope.
7. Report scope, moderation outcomes, deletion/clear support, and behavior after disconnect.
8. The named stream carrying `app_configs`, current timing values, and protocol changes across Android/iOS releases.

## 9. Verification anchors

**Confidence: HIGH.** These method/constant addresses identify the client evidence for future re-verification. Addresses are specific to the covered ARM64 snapshot; they are not wire identifiers. No application binary or disassembly is included in this repository.

| Component | Anchor | Contract area |
| --- | --- | --- |
| `services/climb_service.dart` | `fetchRecentlyDisplayedClimbs` `0x79f0dc` | Read URL, headers, body, response and cache |
| `services/climb_service.dart` | `_recentlyDisplayedKey` `0x79f710`; closures `0x79f7a0`, `0x79f83c`, `0x79f88c` | Cache key, sort, parser, deletion filter |
| `domain/climb.dart` | `Climb.climbDetailFromJson` `0x484028` | Response fields and nullable types |
| `services/climb_service.dart` | `addRecentlyDisplayedClimb` `0x7ddc74` | Publish POST and status handling |
| `domain/recently_displayed_climb.dart` | `toJson` `0x7ddda4` | Eight-key publish body |
| `screen/climbs/detail/climb_detail.dart` | `_writePendingClimbFrames` `0x7dccdc`; `_queueRecentlyDisplayedClimb` `0x7dcff8`; callbacks `0x7dd81c`, `0x7deaa4` | Publish trigger, null attribution, wall lookup, proximity, connection guards |
| `screen/custom_walls/custom_wall_details.dart` | Climb-detail construction `0x7c54f0`–`0x7c5534` | Custom-wall branch selection |
| `services/recently_displayed_debounce_service.dart` | `schedule` `0x7dd5b0`; callback `0x7dd74c` | Pending-event timer |
| `services/climb_service.dart` | `reportRecentlyDisplayedClimb` `0x7d23e4` | Moderation POST |
| `screen/live/live_at_board.dart` | `_preloadLiveAtBoardClimbs` `0x79ee3c`; `_pollRecentlyDisplayedClimbs` `0x79fbf8` | Read auth and refresh lifecycle |
| `provider/app.dart` | `_applyAppConfigRows` `0x8a7d8c`; query `0x8a804c`; schema table object `0x9e9941` | Timing configuration and defaults |
| `provider/login.dart` | `setUserUuid` `0x860760` | Account identifier from JWT `sub` |
