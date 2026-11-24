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
example. Global-admin console operations are not gym-page operations.

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
