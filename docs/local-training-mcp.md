# Local training MCP

The reference integration lives in `packages/mcp`. It is a local stdio server for
Claude Desktop and Codex, backed by a private SQLite logbook mirror and the public
partner OAuth/REST contract. It has no access to Boardsesh application tables,
internal GraphQL, or first-party credentials.

See [installation, login, privacy and operator registration](../packages/mcp/README.md).

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
contract, rather than reusing the mobile GraphQL sync cursor. Clean bounded
bootstrap yields survive CLI exit. Interrupted in-flight bootstraps rebuild a
replacement before publishing; incremental tick changes and their cursor commit
together. WAL readers can search the completed mirror while a background writer
waits on the network.

Offline access is intentional. Confirmed revocation blocks tools, but no local
copy can learn about a remote disconnect without contacting the server. This is
not an immediate remote-erasure guarantee. Logout retains the local cache while
disabling its tool access; users can explicitly remove the profile directory.

The `Local MCP` workflow runs the protocol/security tests and exercises the
standalone package with native SQLite on Linux, macOS and Windows. A real partner
consent and phone workout round trip remains a release gate. The default client
ID comes from the normal developer console and is included in source and release
builds. Global Boardsesh admins can use Boardsesh branding and URLs for their
registrations; ordinary developers retain the reserved-brand restrictions.
Developers can override the client ID explicitly, or use the ID saved in their
profile. Packaging also supports an operator-supplied public client ID.
