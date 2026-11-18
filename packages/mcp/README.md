# Local training MCP

Search your Boardsesh logbook in Claude Desktop or Codex, turn a workout screenshot into a board session, and review what you climbed. History lives in SQLite on your computer. The connector uses the same public OAuth and REST API as other training apps.

## Connect

This proof of concept includes the Boardsesh MCP **public/native** OAuth client ID. Climbers sign in with their Boardsesh account; they never need a client secret or their own app registration.

Requires Node 22.18 or newer. Download the archive, its `.sha256` checksum, and `INSTALL.md` from [GitHub Releases](https://github.com/boardsesh/boardsesh/releases?q=mcp-v). MCP releases are named `mcp-v<VERSION>` and the initial proof-of-concept releases are marked prerelease. After verifying the checksum, install the archive using your package manager. To build from source, run `vp run package:mcp`; the archive is written to `packages/mcp/artifacts/`. Then:

```sh
boardsesh-mcp login
boardsesh-mcp sync
boardsesh-mcp status
```

Login opens your system browser. `--no-browser` prints a URL instead. The callback listens only on `127.0.0.1` for five minutes. Your password is never entered in the terminal or chat. Sign-in asks for logbook reading, workout reading/writing and continued access through refresh tokens.

Developers can use `--client-id` or `BOARDSESH_MCP_CLIENT_ID` to select another public/native registration. Explicit selections are remembered. A normal `login` uses the client ID bundled with the installed release, so a replacement official registration takes effect at the next login. Existing tokens keep their original registration until then. Profiles from the first build with a custom ID retain it as an override.

## Claude Desktop and Codex

Configure a **local stdio server**, not a remote connector. Use the installed executable's absolute path. For a source build:

```json
{
  "mcpServers": {
    "boardsesh": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/boardsesh/packages/mcp/dist/cli.js", "serve"]
    }
  }
}
```

In Codex, register the equivalent command:

```sh
codex mcp add boardsesh -- /absolute/path/to/boardsesh-mcp serve
```

Both clients can share the default profile. To use a separate account, choose a separate `--data-dir` for both login and serve. Starting the server never opens a browser or waits for login. ChatGPT and tunnels are outside this proof of concept.

Try: “Summarize my last four weeks on Kilter.” Or attach a screenshot and ask: “Prepare this workout for Boardsesh. Ask me about anything unreadable.” After checking the plan, ask to create it, open the returned link, and press Start in Boardsesh. Read the results after ending your session.

## Local data and synchronization

The default directory is `~/.local/share/boardsesh/mcp` on Linux (or `$XDG_DATA_HOME/boardsesh/mcp`), `~/Library/Application Support/Boardsesh/mcp` on macOS, and `%LOCALAPPDATA%\Boardsesh\mcp` on Windows. The SQLite database stores your own ticks, sync state and workout drafts. A separate private file holds OAuth tokens. No screenshot, model request, or conversation is stored by this connector. Data returned by tools is sent to the AI client you chose.

Sync runs at startup and every 15 minutes while the server runs. Initial imports continue in bounded batches; `sync_logbook` or the CLI `sync` command also advances a batch. There is no system daemon or webhook listener. Searches and summaries run locally, defaulting to 28 days. Results identify when a complete sync last finished; a partial bootstrap is never presented as a full logbook.

Offline reads work after the first complete sync. A remote disconnect cannot be detected offline. On confirmed credential invalidation, all clients sharing this profile stop returning cached history until you reconnect. Network outages and rate limits preserve the cache. An uncertain refresh requires login again rather than risking reuse of a spent refresh token.

`logout` disables local access and attempts to revoke this installation's saved refresh token. Its output tells you whether remote revocation succeeded. It does not disconnect every installation of the app. Use Boardsesh Connected apps to end the whole connection. Cached files are retained locally, inaccessible through logged-out tools. Logging in as another account removes the previous account's tick rows and sync state; old draft records remain account-isolated. Unresolved drafts are pruned in bounded batches once their expiry is more than seven days old; saved creation results are retained to avoid duplicate workouts. SQLite deletion is not secure disk erasure; remove the data directory yourself if you want to remove the whole profile.

Windows verifies private file permissions on each credential read. This can add PowerShell startup latency; permission verdicts are not cached against file timestamps because ACL changes need not change those timestamps.

## Tools and limits

| Tools | What they do |
| --- | --- |
| `get_connection_status`, `sync_logbook` | Check login/freshness and advance synchronization |
| `search_logbook`, `summarize_logbook` | Local filtered search and grouped activity counts |
| `prepare_workout`, `create_workout` | Preview a plan, then create it with a stable request identity |
| `list_workouts`, `get_workout` | Read this integration's workouts and results |
| `cancel_workout` | Cancel a workout that has not started |

Search pages default to 50 ticks, with a maximum of 200. Summary groups are capped at 200 and report truncation. Dates are inclusive UTC timestamps. Grades are grouped by board, layout and angle; summary counts describe recorded climbing, not an inferred medical or training-load measure. Climb metadata can drift without a tick changing in the partner feed.

Drafts expire after 24 hours and belong to the current account/login generation. Reuse the same draft ID after a failed create request. Workout writes require online access and are never queued for later. A prepared plan explains native versus freeform blocks; `fourByFour` and `limitBouldering` currently remain freeform. The climber starts the workout in Boardsesh. Tools do not control Bluetooth, alter an active queue, write ticks, or read another partner's workouts.

## Operator registration and release

The built-in client is registered through the normal developer console as **public/native**, with `http://127.0.0.1/oauth/boardsesh` as the redirect (runtime ports vary). A Boardsesh global admin can create or edit their registration using **Boardsesh MCP**, the **Boardsesh** publisher, and Boardsesh homepage/privacy URLs. Other developers must use their own branding and URLs. Admin registrations retain the normal ownership, terms, scope, consent, PKCE and connection-limit requirements.

The public client ID is safe to distribute. The standard build includes it; set `BOARDSESH_MCP_PUBLIC_CLIENT_ID` when running `vp run package:mcp` to package a different registration. Never set a client secret. Follow the partner platform rollout gates and connection limits before inviting climbers.

After an MCP change merges into `main`, the `Local MCP` workflow builds and tests the archive on Linux, macOS and Windows, verifies Windows credential permissions, then publishes a GitHub prerelease with the archive, SHA-256 checksum and this installation guide. Pull requests and manual validation runs never publish. Release assets come from that same tested workflow artifact. Bump `packages/mcp/package.json` for each new public version; an already-published version is left unchanged. Failed uploads leave a draft that a rerun for the same commit can finish. This does not publish to npm or activate partner access.

Validate with `vp run typecheck:mcp`, `vp test run --project mcp --reporter=agent`, `vp run package:mcp`, and `vp exec node packages/mcp/scripts/smoke.mjs`. Loopback-login tests require permission to listen locally. The desktop CI matrix checks the installed archive on Linux, macOS and Windows. Live consent and phone workout handoff still require an enabled partner environment and a test account.
