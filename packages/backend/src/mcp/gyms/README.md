# Gym MCP action parity

`registry.ts` is the explicit action catalogue. `media-tools.ts` registers image
actions and source readback. Every action uses the caller's live Boardsesh identity, existing
gym/board permissions and existing resolver validation. Clients cannot submit a
GraphQL document or choose another actor. Explicit admin scopes expose the
separately gated directory-repair tools in `admin-tools.ts`.

| Existing gym surface | MCP actions | Important permission boundary |
| --- | --- | --- |
| Overview | `list_managed_gyms`, `search_gyms`, `get_gym` | Management predicates run before pagination; ordinary membership alone never qualifies. |
| Profile | `update_gym_profile`, `get_gym_upload_links`, `set_gym_image`, `remove_gym_image`, `get_gym_image_source` | Gym edit rights; private/unlisted visibility and owner-vouched website rules remain backend-owned. Local files use the existing signed-in upload page. Imports retain their source and optional credit in the directory audit. |
| Branding | `update_gym_branding`, `reset_gym_branding`, image actions for `kind=logo` | Logo and visible primary/accent colours; unused background colour is only cleared when resetting, matching the UI. |
| Boards | `list_gym_boards`, `get_gym_board`, `get_board_setup_options`, `list_linkable_gym_boards`, `link_owned_board_to_gym`, `list_nearby_gym_boards`, `attach_nearby_board_to_gym`, `remove_board_from_gym`, `update_gym_board`, `delete_gym_board` | Gym editors can detach but cannot edit wall setups. A climber keeps their own board; staff may delete SYSTEM boards only. The creator's removal is an unlink, matching the gym page. |
| Board report review | `list_gym_board_reports`, `apply_reported_board_setup`, `keep_reported_gym_board` | Notes and setup suggestions omit reporter identities, including for globally privileged callers. Existing escalation, resolution and automatic closure rules apply. |
| Members | `list_gym_members`, `search_gym_staff_candidates`, `grant_gym_edit_access`, `revoke_gym_edit_access`, `remove_gym_member` | Writes require the separately consented `gyms:access:write` scope. Editors cannot spread access; community leaders cannot remove arbitrary gym members or grant admin. |
| Discussion | `list_gym_comments`, `add_gym_comment`, `update_gym_comment`, `delete_gym_comment`, `vote_on_gym_comment` | Posts use the caller's identity. A staff role does not permit editing/deleting somebody else's comment. Replies/votes bind to the selected gym. |
| TVs and sharing | `list_gym_kiosks`, `create_gym_kiosk`, `update_gym_kiosk`, `delete_gym_kiosk`, `get_gym_sharing_links` | Kiosk and layout boards must belong to the gym. Sharing returns existing TV/poster URLs and UUID-based embed snippets; private previews are marked as requiring sign-in. |
| Insights | `get_gym_insights`, `get_gym_grade_comparison`, `list_gym_grade_collections`, `set_gym_grade_collection`, `set_gym_reporting_timezone`, `group_gym_reporting_boards` | Reports preserve source coverage, timezone, period boundaries and per-board grade-comparison inclusion/status. Collection choices use the backend's bounded search and cursor pages, private-collection access and board-compatibility checks. Physical-wall grouping requires gym owner/admin, rather than editor/community authority. |
| Linked public-page actions | `follow_gym`, `unfollow_gym`, `get_pending_gym_claim`, `request_gym_claim`, `report_gym_problem`, `report_gym_board_problem`, `report_duplicate_gym` | Signed-in visible-gym rules apply. Claims still require mailbox verification or manual review; duplicate reporting never merges a gym. |

## Write and retry contract

Every mutation requires a UUID `idempotencyKey`. Repeating that key with the same
action and normalized arguments returns its result without repeating the action;
changed arguments conflict. Receipts are isolated by account, OAuth client and
connection generation. OAuth revocation, gym permission changes and child-resource
visibility are rechecked before returning a receipt. Destructive acknowledgements
use `confirm=true`, including the existing explicit source-gym merge and duplicate
setup overrides. This parameter is not evidence of human approval by the client.

The OAuth connection lock, live authorization, fixed resolver execution and receipt
insert share one database transaction. Existing inner transactions become
savepoints. Effects such as live events run after the outer commit. Receipt
payloads expire after seven days; expired keys remain tombstones so a delayed
retry cannot silently repeat a write.

Gym access uses the website's shared edit, grant, admin and visibility rules in
`resolvers/social/gyms.ts`, with an optional authorization-evidence lock. That
module also owns the managed-list SQL predicate and its role-parity tests.
Writes prepare a closure once, inside the authorized transaction, and reuse its
canonical arguments and child bindings for the resolver call. Retries prepare
again under fresh locks. Initial operation permissions belong to the resolver;
receipt replay uses those same shared guards without repeating the mutation.
Deleted/unlinked replay exceptions apply only to matching operation/input
receipts. Web and MCP iframe snippets share `@boardsesh/kiosk` builders.

## Resolver authoring inside a delegated write

Gym MCP writes use one outer database transaction for authorization, the
resolver mutation and its retry receipt. The shared `db` and `dbRead` handles
bind to that transaction inside its asynchronous scope; outside it, they use
their normal primary/replica clients. This binding applies to existing resolvers
even though the MCP endpoint defaults to off.

If a resolver must recover from a SQL error and continue querying, put the
fallible work inside `db.transaction(...)` and catch outside that callback.
Inside a delegated write this creates a savepoint; catching a SQL error directly
leaves the outer PostgreSQL transaction aborted. Otherwise rethrow the error so
the action and receipt roll back. Queue external effects with the after-commit
helpers rather than running them before the outer transaction commits.

The MCP write's two-second lock timeout and ten-second statement timeout apply
to individual database statements. They do not cap total transaction duration;
keep network work outside the transaction and avoid unbounded resolver loops.
See [hosted gym MCP](../../../../../docs/integrations/hosted-gym-mcp.md) for rollout and
deployment order.

## Deliberate boundaries

The ordinary tools cover the gym page, rather than every resolver containing the
word "gym". Global-admin claim review/revert, ownership reassignment and cron
refreshes remain outside this server.
`deleteGym` and `addGymMember` exist in the backend but are not controls in the
current web Manage page, so they are not automatically exposed.

`gyms:admin:read` adds explicit-ID duplicate inspection. `gyms:admin:write` adds
reasoned setup corrections, explicit location publication/hiding, canonical-slug repair, audited gym
merges, and serial-independent public catalogue board merges. The normal consent
defaults never include these scopes. Both the OAuth grant and a live global admin
role are required, including tool discovery and receipt replay; a gym admin or a
board-scoped community admin is insufficient. Setup corrections retain the existing
duplicate-config acknowledgement and privacy restrictions. Only the dedicated
location repair can override another board owner's location policy.

Repair hashes are obtained by inspection and checked under row locks. Board merges
require matching normalized configurations and explicit same-physical-wall
acknowledgement, preserve original reporting and moderation provenance, and refuse
restricted access state or incompatible dependent settings. Existing serial dedupe
uses the same extracted history migration body; its discovery and locking contract
remains separate. See [the operator workflow](../../../../../docs/integrations/hosted-gym-mcp.md#administrative-duplicate-repairs).

MCP board projections omit pairing serials and numeric internal IDs. Existing
field-level privacy determines creator names, locations and readable board
content. The owner may supply a serial when editing their own board, as on the
gym page, but the MCP response does not repeat it.

`get_gym_mcp_capabilities` is available to every admitted connection. It explains
hidden tools by naming their required scope and global role without returning
gym content or granting access. Profile/photo writes require `gyms:write`, even
on a connection approved for `gyms:admin:write`. Board setup options use the
shared catalogue cascade so MoonBoard (including screw-on feet) and Woods are
available alongside Aurora boards; an incomplete catalogue is an explicit error.

Ordinary scopes never read or disclose the account's global-admin role;
capabilities report that status as `null` until an admin scope is explicitly
consented. Media registration, capability discovery and hidden-call denials share
one name/scope catalogue in `media-tool-metadata.ts`.

## Validation

The document test validates every committed operation against the shared schema
and rejects pairing-credential/reporter-identity selections. Registry tests cover
surface parity, action scopes, confirmation/duplicate guards, canonical gyms,
cross-gym child refusal, discussion scoping and private sharing. Dispatch tests
cover same-transaction receipts, unchanged retry, changed-input conflict,
expired-key refusal, current-role revocation and OAuth disconnect before replay.
The role/privacy and concurrency integration suites remain the authority for the
underlying gym and board permission rules.
