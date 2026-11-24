# Hosted gym-management MCP

Gym owners, admins, editors and community leaders can connect an assistant to
the gyms their Boardsesh account can manage. The server runs inside the existing
backend service, at `https://api.boardsesh.com/mcp/gyms`. Nothing runs on the gym
owner's computer, and they do not register a developer app or copy API secrets.

This is separate from the [local training MCP](local-training-mcp.md), whose
private SQLite mirror and workout tools remain local.

## Connecting an assistant

The website guide is `/developers/gym-mcp`, linked from the Manage gym overview
when the backend reports that the connector is enabled. The guide is a setup
utility, self-canonical and `noindex, follow`; it is excluded from the sitemap.
Its instructions and OAuth scope descriptions are translated into every
supported locale.

1. Copy `https://api.boardsesh.com/mcp/gyms` from the guide.
2. Add a custom remote MCP server in ChatGPT plugins or Claude connectors.
3. Choose OAuth and the provider's published client identity option.
4. Sign in to Boardsesh and review the requested gym access.
5. Ask the assistant which gyms you can manage.

Provider account plans, workspace policies and connection screens change. Follow
the current [ChatGPT guide](https://developers.openai.com/api/docs/guides/custom-mcp-server)
or [Claude guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
The initial release uses custom connectors; directory listings are a later step.

## Access and consent

The MCP resource has separate OAuth scopes:

| Scope | What the user approves |
| --- | --- |
| `gyms:read` | Read gym information, boards, members and existing activity reports. |
| `gyms:write` | Change gym content, boards, TVs and discussions within the user's current permissions. |
| `gyms:access:write` | Change staff access where the user's current role allows it. |
| `offline_access` | Refresh the connection until the user disconnects it. |

One connection covers every gym the account can currently manage, including
gyms it gains access to later. A lost role removes the corresponding access;
OAuth approval does not grant a gym role. Ordinary membership alone is not
management access. Existing per-operation rules remain authoritative: gym staff
cannot delete another climber's board or edit someone else's comment, for
example. Directory repairs have a separate global-admin surface described below.

If a tool is missing, call `get_gym_mcp_capabilities` (no arguments). It is
available on ordinary and admin-only connections and returns granted scopes,
each named operation's required scope, and any missing global-admin role.
Without an explicit admin scope, global-admin status is `null`: ordinary
connections neither read nor disclose that account role. After admin consent,
the current role determines which admin tools are available.
`update_gym_profile`, `set_gym_image` and `remove_gym_image` already exist and
require **`gyms:write` plus current gym edit access**. A token approved only for
admin repairs does not include ordinary gym writes. Reconnect requesting
`gyms:read gyms:write` for profile/photo work; request the admin scopes separately
for directory repair. Existing tokens do not gain permissions after an update.
Direct calls without a required scope name that scope in the authorization error.

`update_gym_profile` accepts a partial `changes` object: `name`, `description`,
`address`, `website`, `contactPhone`, `contactEmail` and `hours` are supported.
Send only the fields being changed. Omitted fields, owner and memberships stay
unchanged; explicit nullable fields can be cleared with `null`. Visibility is
unchanged unless explicitly included. Read the saved result with `get_gym`.

The consent screen displays the client identity hostname separately from the
client's self-reported name. A client calling itself ChatGPT or Claude does not
gain a trusted publisher identity or more permissions.

Users review writes and sensitive actions in the assistant. The assistant owns
the confirmation experience; MCP annotations and acknowledgement parameters do
not prove that a person approved a request. Boardsesh enforces current grants,
gym roles and resource permissions itself.

Tool results go to the chosen assistant. The user's Boardsesh password is
entered only on the Boardsesh sign-in page. Disconnecting in Settings →
Connected apps stops future tool calls and refreshes. Information already
shared with the assistant remains with it. The same Connected apps scope
descriptions appear on web and mobile.

## Administrative duplicate repairs

Global administrators can explicitly consent to `gyms:admin:read` and
`gyms:admin:write` on the same MCP resource. Neither scope is part of the
ordinary connection defaults. Existing tokens do not gain these scopes when
the server is updated. A connection needs fresh consent requesting the admin
scopes; a gym's owner, staff admin or board-scoped community admin does not
qualify. The server checks the live global role at consent, token exchange,
refresh, tool discovery, every call and retry replay. Revocation prevents new
admin actions and access to their receipts.

The admin read scope allows inspection across gym listings, including differently
named duplicates. The admin write scope allows cross-owner directory corrections
and merges, including deliberately making a board's location public. The consent
and Connected apps descriptions state this authority explicitly. Ordinary board
editing retains its owner-only privacy rules.

| Admin tool | Operation |
| --- | --- |
| `inspect_gym_duplicates` | Compare explicit gym UUIDs, board configurations, owner account IDs and display names, privacy, history counts and distances; return current state hashes. Pairing credentials, emails and individual climber activity are omitted. |
| `correct_gym_board_setup` | Correct layout, size, hold sets, angle or adjustability through the existing board writer. Use `allowDuplicateConfig=true` explicitly when a confirmed duplicate already has that setup. Existing logged climbs keep their original problem identities. |
| `correct_gym_board_location_visibility` | Set location visibility explicitly, synchronizing `hideLocation` and the location policy without changing owner, board audience or access grants. Record the reason and previous state. |
| `merge_duplicate_gyms` | Choose the surviving gym UUID, move its duplicates' linked records, retain the survivor's owner, and keep old gym links resolving through merge tombstones. Board rows remain separate. |
| `repair_gym_canonical_slug` | Promote an explicitly approved alias held by a merged gym to the active survivor's canonical URL. Exchange the two slugs while keeping owners, deleted state, merge pointers, old URLs and UUID resolution intact. |
| `merge_duplicate_gym_boards` | Consolidate confirmed records of one physical public catalogue wall by UUID. Serial numbers are optional. Preserve history, ticks, follows, pins, valid TV layouts and old links. The survivor keeps its owner. |

All admin writes require an explicit reason, `confirm=true`, a UUID retry key and
the current state hash for every affected gym or board. Board merges additionally
require `samePhysicalWall=true`: matching coordinates or configurations alone are
not proof. Hashes cover configuration, ownership and privacy state; a changed
record requires a new inspection. Reuse a retry key only with the exact original
arguments. Successful merge retries recognize the resulting tombstones rather
than trying to merge them again.

For a canonical URL repair, inspect the survivor and the alias-holding tombstone
together. Supply `gymUuid`, `aliasGymUuid`, the approved `slug`, the survivor's
`expectedStateHash` and tombstone's `expectedAliasStateHash`, plus the reason,
`confirm=true` and `idempotencyKey`. The alias must already resolve through a
valid merge chain to that active survivor. Unrelated slug collisions, cycles,
deleted destinations and stale state are refused. The old survivor slug moves
to the tombstone, so both URLs keep reaching the same gym without reviving a
duplicate. Sharing links use the survivor's saved slug. The write and durable
`gym_directory_repair_audit` record commit with the retry receipt; replay checks
current global-admin authority and the surviving merge association.
Merged aliases remain reserved when creating, renaming or importing another
gym. A delayed edit cannot rename a listing that became a merge tombstone.

The chosen board keeps its owner. A different real creator of a merged-away row
loses editing ownership, follows the survivor and receives a moderation notice.
Inspect the owner account IDs and display names first. Such a merge requires
`allowOwnershipChange=true`; leaving it false refuses the merge. SYSTEM-only
source rows do not need that extra acknowledgement. The audit records the choice
and original owners; no email addresses or pairing serials are returned.

Affected TV layouts must pass the current strict writer schema. An invalid or
unknown layout returns a conflict naming the kiosk UUID and stays unchanged;
repair it separately before retrying. Merge invalidation clears only loser board
previews. The survivor is refreshed from its current session, and later queue
updates and session endings follow explicit merge pointers while respecting the
current public or private session on that wall.

A typical repair follows this order:

1. Inspect the explicit gym UUIDs and establish which physical gym/wall they describe.
2. Merge duplicate gyms into the chosen survivor, preserving the intended ownership.
3. Inspect again and correct stale board configurations separately.
4. Explicitly correct location visibility if the operator wants that change.
5. Inspect again, then merge the matching board UUIDs into the chosen survivor.

The initial board-merge contract supports public, listed catalogue boards. Spray
walls, restricted policies, explicit access grants, active share links, existing
physical reporting groups and conflicting grade collections require their own
review and return a conflict rather than silently changing access or settings.
Legacy hidden-location flags remain restrictive unless explicitly corrected.

Event sequences advance above every reserved sequence. Reporting board/gym
snapshots, original moderation events and source provenance retain their original
identities; merging cannot retroactively establish where a climb happened or
grant staff access to hidden activity. Directory reports close through the existing
report lifecycle. Gym merge audits and board moderation records retain the acting
admin and reason. Updates and their receipt commit together; notifications and
TV refreshes wait until that outer commit. Referencing writers lock the active
identity so a concurrent action either commits before consolidation or refuses a
stale merged identity.

These tools provide operations only. Shipping them neither activates the connector
nor applies a production merge.

## Images and reports

For photos and logos, provide a public HTTPS image URL to the assistant. Local
files can still be uploaded from the gym's Profile or Branding tab. The upload
path retains image type, size and decoding checks. Web uploads save the gym's
image in the same request. Every new upload gets a distinct filename; replacing
or clearing an image removes its previous original and variants after commit,
including older web uploads. Changing only the URL's cache version preserves
the same stored object. Deploy the backend before the web uploader: the new
web client requires the saved `gym` in the upload response. Older web clients
remain compatible with the new backend. A generated image is not a
substitute for the real gym photo required by the existing gym UI.

Use `get_gym_upload_links` for the signed-in local-file upload pages, or
`set_gym_image` with `kind=photo|logo`, `imageUrl`, `confirm=true` and a UUID
`idempotencyKey` to import a direct public image. It accepts optional
`attribution: { credit, pageUrl?, license? }`. Supply the real source and credit
when known; a sanitized import URL is always recorded. Source and attribution-page
URLs retain only HTTP(S) origin and path: credentials, query strings and fragments
are removed before durable storage or readback. The original signed URL is used
only to fetch the image. Source evidence is saved in the
directory audit in the same transaction as the image, independently of the
seven-day retry-result retention. `get_gym_image_source` requires `gyms:read`
and gym edit access and returns the currently saved URL and matching source
evidence. Older and web-uploaded images may have no recorded source. A later
replacement never inherits a different image's credit. `get_gym` returns the
saved profile, photo and logo; photo changes preserve the other image and all
unpatched profile fields.

Directory audit actor IDs clear automatically when that account is deleted,
matching existing gym-merge audits. The repair evidence and sanitized image
source/credit remain; source readback selects only evidence matching the gym's
current saved image and never returns actor identity or older image records.

`get_board_setup_options` uses the shared board-setup catalogue, including
MoonBoard's code-defined layouts. For `boardType=moonboard`, Masters 2019 is
layout `5`, Standard is size `1`, and its sets are `17`–`23`, including Screw-on
Feet (`20`). Catalogue inspection requires no controller serial. Empty or
incomplete catalogues return `BOARD_SETUP_OPTIONS_UNAVAILABLE` with recovery
guidance instead of a successful empty result.

Activity results retain the website's reporting timezone, attribution and
coverage caveats. An assistant should not treat missing reporting coverage as
proof that no one climbed. See [Gym Insights reporting](../analytics/gym-reporting.md).

Grade comparison is a separate report: `get_gym_grade_comparison` compares the
current available climbs with sends during the chosen period. The collection
picker and `set_gym_grade_collection` use the website's board compatibility and
collection visibility checks. Selecting a collection retains the resolver's
repeatable-read snapshot across the OAuth check, mutation and retry receipt.

## Availability and launch

The backend owns rollout state. `GYM_MCP_MODE` defaults to `off`; `pilot` and
`on` still require a serving `PARTNER_OAUTH_MODE` (`allowlist` or `open`). This
does not activate partner developer registration or change ordinary partner
scope/resource limits.

For a pilot, set `GYM_MCP_PILOT_USER_IDS` to a comma-separated list of Boardsesh
account IDs on the backend. A pilot with an empty list admits no users. Switch
to `on` only after the checks below pass; changing the gym mode never overrides
the parent OAuth `off` or `hold` switch.

Pilot client metadata is restricted to the exact HTTPS origins
`https://chatgpt.com` and `https://claude.ai`, before any metadata fetch or
OAuth client persistence, including requests without a browser session.
`GYM_MCP_PILOT_CLIENT_ORIGINS` replaces this list with comma-separated HTTPS
origins; include the defaults when adding another trusted assistant. An empty
list refuses every metadata identity. Malformed origins also refuse gym metadata
and emit `INVALID_PILOT_CLIENT_ORIGINS` at most once per minute; training
integrations keep loading normally.
Subdomains and non-default ports require their own explicit entries. This
restriction applies in `pilot`; `on` admits other validated public HTTPS
metadata identities. The providers' current published identities are
[ChatGPT](https://chatgpt.com/oauth/client.json) and
[Claude](https://claude.ai/oauth/mcp-oauth-client-metadata); the origin policy
also accepts their other validated metadata paths.

CIMD identities use server-owned `oauth_mcp_client_policy` rows. Their defaults
are 10,000 active connections and 1,000 new connections per rolling 24 hours,
per client identity. They do not inherit developer-owned partner applications'
25-active / 20-new connection caps, and deleting the first gym owner who
connects does not delete anyone else's assistant. Suspending the policy through
`oauth_mcp_client_policy.suspended_at` or disabling `oauth_client.disabled`
blocks existing MCP access tokens as well as new connections.

Client metadata has a 5 KB streaming cap and a five-second total deadline,
including DNS lookup and body reading. The transport validates public DNS
addresses, pins the selected address, verifies TLS against the original host,
and never follows redirects. A bounded validated cache retains metadata for at
most 60 seconds and respects restrictive cache directives such as `no-store`,
`private`, and `no-cache`. Metadata fetching finishes before OAuth database
locks are taken. Public clients use S256 PKCE; client secrets and remote key
fetches are not required.

The per-address authentication cap is shared by users behind a provider's
egress address. The fixed `pending_auth_address_refusals` field in per-minute
Public API Usage summaries counts this branch in the anonymous MCP bucket;
request logs also identify `admissionRefusal=pending_auth_address_cap`.
Neither records an IP address or bearer token. Review this counter before
opening `GYM_MCP_MODE=on` so shared-provider bursts can be measured.

Successful mutation receipts retain their result for seven days. The hourly
sweeper drains expired result payloads in transactions of at most 1,000 rows
until it reaches a short batch. Concurrent processes skip locked receipts;
overlapping calls within one process share the current sweep. Retry identities
remain indefinitely, including old connection generations, so an old retry
cannot accidentally execute the change again. These metadata tombstones grow
with successful writes until their user or client is deleted; the pilot
intentionally accepts this cost rather than permitting delayed duplicate writes.
Claim requests return `email_requested` rather than claiming email delivery;
an explicit resend is a new action with a fresh retry key.

The public `GET /mcp/gyms/status` probe returns `enabled` and
`invitationRequired` booleans, without user or invitation details.
The web server calls it with a short timeout and no shared cache. A failure hides
the overview entry while ordinary gym management continues to work. The setup
guide remains available and explains staged access. During a pilot, the card
and guide tell managers to wait for an invitation before starting OAuth.
No matching web environment
toggle is required.

Before opening access, verify a real ChatGPT and Claude browser sign-in, a
read-only connection, an approved write, a denied role boundary, token refresh,
and disconnect from Connected apps. A code change alone does not establish that
the public endpoint is activated or that either provider's live client passed.
Before enabling `on`, decide the open-registration policy and retention of
unconnected CIMD clients; the current implementation does not expire those
client records. The pilot origin restriction remains a pilot-only policy.

Preview inheritance from a Redis-only session requires a recent direct public-board merge audit on the current survivor. Older CLI merges and later flattened merge chains fail closed; report a fresh climb on the survivor to establish its current binding. No Redis binding is rewritten by the merge.
