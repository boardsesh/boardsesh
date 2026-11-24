# Gym MCP action parity

`registry.ts` is the explicit action catalogue. `media-tools.ts` registers the two
image actions. Every action uses the caller's live Boardsesh identity, existing
gym/board permissions and existing resolver validation. Clients cannot submit a
GraphQL document, choose another actor, or request global-admin operations.

| Existing gym surface | MCP actions | Important permission boundary |
| --- | --- | --- |
| Overview | `list_managed_gyms`, `search_gyms`, `get_gym` | Management predicates run before pagination; ordinary membership alone never qualifies. |
| Profile | `update_gym_profile`, `get_gym_upload_links`, `set_gym_image`, `remove_gym_image` | Gym edit rights; private/unlisted visibility and owner-vouched website rules remain backend-owned. Local files use the existing signed-in upload page. |
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

## Deliberate boundaries

These tools cover the gym page, rather than every resolver containing the word
"gym". Global-admin claim review/revert, ownership reassignment, arbitrary gym
merges, orphan/duplicate audits and cron refreshes remain outside this server.
`deleteGym` and `addGymMember` exist in the backend but are not controls in the
current web Manage page, so they are not automatically exposed.

MCP board projections omit pairing serials and numeric internal IDs. Existing
field-level privacy determines creator names, locations and readable board
content. The owner may supply a serial when editing their own board, as on the
gym page, but the MCP response does not repeat it.

## Validation

The document test validates every committed operation against the shared schema
and rejects pairing-credential/reporter-identity selections. Registry tests cover
surface parity, action scopes, confirmation/duplicate guards, canonical gyms,
cross-gym child refusal, discussion scoping and private sharing. Dispatch tests
cover same-transaction receipts, unchanged retry, changed-input conflict,
expired-key refusal, current-role revocation and OAuth disconnect before replay.
The role/privacy and concurrency integration suites remain the authority for the
underlying gym and board permission rules.
