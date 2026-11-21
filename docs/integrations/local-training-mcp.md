# Local training MCP

The reference integration lives in `packages/mcp`. It is a local stdio server for
Claude Desktop and Codex, backed by a private SQLite logbook mirror and the public
partner OAuth/REST contract. It has no access to Boardsesh application tables,
internal GraphQL, or first-party credentials.

See [installation, login, privacy and operator registration](../../packages/mcp/README.md).

The two proof flows are:

1. Read a climber's history, prepare a board workout, open its launch link, and
   read the completed results to plan the next session.
2. Interpret a screenshot in the host LLM, clarify uncertain details, prepare a
   structured workout, and create it through the same partner API.

OAuth uses the built-in Boardsesh public/native client ID and loopback PKCE.
Run `boardsesh-mcp login`; users need no client secret or app registration.
Each installation holds its own token family; clients sharing a local data
directory share that profile. API keys, hosted MCP, live board control, and
ChatGPT tunnelling are outside this implementation.

The SQLite cursor engine deliberately implements the public snapshot/change-feed
contract, rather than reusing the mobile GraphQL sync cursor. Committed bootstrap
pages survive bounded yields, handled network failures and rate limits, including
when the next sync runs in another CLI process. A process crash during an in-flight
bootstrap still rebuilds a replacement before publishing; incremental tick changes
and their cursor commit together. WAL readers can search the completed mirror
while a background writer waits on the network.

Offline access is intentional. Confirmed revocation blocks tools, but no local
copy can learn about a remote disconnect without contacting the server. This is
not an immediate remote-erasure guarantee. Logout retains the local cache while
disabling its tool access; signing in to another account removes the other accounts'
logbook rows and sync cursors atomically with the profile switch. Workout drafts
remain account-isolated: unfinished requests are kept for at least seven days
after draft expiry so an ambiguous creation can be reconciled. Preparing a workout
removes at most 100 older unfinished drafts; saved remote workout identities are
retained. Users can explicitly remove the profile directory to discard all local
history and draft records.

The `Local MCP` workflow runs the protocol/security tests and exercises the
standalone package with native SQLite on Linux, macOS and Windows. A real partner
consent and phone workout round trip remains a release gate. The default client
ID comes from the normal developer console and is included in source and release
builds. Global Boardsesh admins can use Boardsesh branding and URLs for their
registrations; ordinary developers retain the reserved-brand restrictions.
Explicit developer client IDs are remembered. Normal logins use the bundled
registration, including a replacement supplied by a later release; existing
tokens stay bound to their original client until login. Packaging also supports
an operator-supplied public client ID.

Merging an MCP change to `main` runs the desktop checks and publishes the tested
archive, SHA-256 checksum and installation guide as `mcp-v<VERSION>` on GitHub
Releases. Initial builds are prereleases. PR and manual validation runs never
publish. Increment the package version for a new download: published versions
are immutable. Failed uploads remain drafts and can be retried for the same
commit. The first release's phone round trip must be checked before merging.
