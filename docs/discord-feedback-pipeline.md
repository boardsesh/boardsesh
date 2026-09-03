# Discord mention → GitHub issues

Mention the Boardsesh Discord bot when a conversation should become a GitHub
issue. The bot starts a targeted GitHub Actions run immediately; there is no
scheduled channel scan.

Example:

```text
@Boardsesh Issues Create an issue for this. Keep the reproduction steps.
```

One command creates one issue by default. A maintainer can explicitly ask for
multiple issues, with a hard limit of five.

This is the third feedback-to-issue path alongside TestFlight feedback and the
in-app report form. It shares the same public labels, PII redaction, durable
attachment hosting, and marker-based recovery.

## What context is collected

The workflow resolves the mention in this order:

1. **Inside a thread:** the thread starter plus the newest 50 human messages.
2. **A reply in a normal channel:** the human message being replied to.
3. **A standalone channel mention:** up to 10 preceding human messages, all from
   the prior 30 minutes.

Bots, webhooks, system messages, and the issue bot itself are excluded. At most
four image attachments are copied from the selected context. The collected JSON
contains pseudonymous reporter references, never Discord user names or raw user
IDs.

## Runtime path

The existing Discord application supplies both halves:

- `packages/backend/src/services/discord-gateway-client.ts` uses the backend's
  existing `ws` dependency for a Discord Gateway v10 connection, heartbeats,
  `MESSAGE_CREATE` events, and the two required Discord REST writes.
- `packages/backend/src/services/discord-issue-bot.ts` validates mentions,
  suppresses duplicates, and dispatches the GitHub workflow.
- `.github/workflows/discord-feedback-issues.yml` re-fetches and processes the
  exact message after the backend dispatches it.

The backend ignores bots, webhooks, other guilds, messages without an exact bot
mention, and authors outside `DISCORD_ISSUE_TRIGGER_USER_IDS`. It sends only
`channel_id` and `trigger_message_id` to GitHub. A Redis `SET NX` claim prevents
two backend instances from dispatching the same message; a 15-minute local claim
is the fallback when Redis is unavailable.

After GitHub accepts the dispatch, the bot adds 👀. A successful run replaces it
with ✅ and replies once with every issue URL. A failed dispatch or workflow uses
❌ and asks the maintainer to mention the bot again.

## Job isolation

The workflow uses three jobs:

| Job | Environment | Permissions | Credentials |
| --- | --- | --- | --- |
| `collect` | `discord-feedback` | contents read | Discord bot token |
| `triage` | none | contents/issues read, OIDC | Claude OAuth token |
| `apply` | `discord-feedback` | contents/issues write | Discord bot token, workflow token |

The collect job re-fetches the message and repeats the guild, mention, and
maintainer checks. Workflow inputs are not authorization.

Only `bundle.command.instruction` is an authorized instruction. The selected
feedback and surrounding conversation remain untrusted public text. The triage
job has no Discord credential and no repository write permission. Its sole
write is an ephemeral decisions JSON file.

Collect pins a SHA-256 digest before triage. Apply rejects a missing or changed
bundle and validates the complete decisions array before any GitHub or Discord
write. A single invalid field rejects the whole result. Titles, bodies, labels,
decision indexes, command ID, duplicate URLs, and the five-issue cap are all
checked in TypeScript rather than trusted to the model.

## Idempotency

Each possible issue gets a stable first-line marker:

```html
<!-- discord-feedback:<trigger-message-id>:<issue-index> -->
```

Workflow concurrency is also keyed by the trigger message ID. If issue creation
succeeds and a later step fails, retrying finds each existing marker and reuses
its issue URL before updating Discord. The command is acknowledged only after
all requested issues are created or recovered.

## One-time setup

### Discord application

Reuse the current bot application. Rename its server nickname to **Boardsesh
Issues** so maintainers have an obvious account to mention.

In the Discord Developer Portal:

1. Enable the privileged **MESSAGE CONTENT** Gateway intent.
2. Keep Server Members intent disabled; this feature does not need it.
3. Grant the bot View Channels, Read Message History, Add Reactions, Send
   Messages, and Send Messages in Threads.
4. Scope its channel access with Discord role/category permissions. It only
   reads context around an authorized mention, but it should still have no
   access to private moderator channels it does not need.

### GitHub App

Create a dedicated GitHub App, install it only on `boardsesh/boardsesh`, and
grant repository **Actions: Read and write**. No webhook is needed. Generate a
private key.

The backend signs a nine-minute app JWT, resolves its installation, requests a
short-lived installation token limited to this repository and `actions: write`,
then dispatches the fixed `discord-feedback-issues.yml` workflow on `main`.
Neither the workflow name nor the ref comes from Discord.

### Backend variables

Set these on the production `boardsesh-backend` Railway service:

| Name | Value |
| --- | --- |
| `DISCORD_ISSUE_BOT_ENABLED` | `false` during setup; set `true` after the workflow is on `main` |
| `DISCORD_BOT_TOKEN` | Existing Discord bot token |
| `DISCORD_GUILD_ID` | Boardsesh guild ID |
| `DISCORD_ISSUE_TRIGGER_USER_IDS` | Comma/space-separated maintainer Discord IDs |
| `DISCORD_GITHUB_APP_ID` | Dedicated GitHub App ID |
| `DISCORD_GITHUB_APP_PRIVATE_KEY` | PEM private key; literal newlines or escaped `\n` both work |

Startup failures are logged under `[discord-issue-bot]` and reach the backend's
normal error/Sentry transport without taking the Boardsesh API offline. Initial
Discord connection failures retry from five seconds up to a five-minute cap;
Discord.js handles reconnects after a session is established.

### GitHub configuration

Keep the dedicated, reviewer-free `discord-feedback` environment. It needs:

| Name | Kind | Value |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | environment secret | Same existing bot token |
| `DISCORD_GUILD_ID` | environment variable | Boardsesh guild ID |
| `DISCORD_ISSUE_TRIGGER_USER_IDS` | environment secret | Same maintainer allowlist as the backend |
| `CLAUDE_CODE_OAUTH_TOKEN` | repository secret | Existing Claude Code subscription OAuth token |
| `DISCORD_FEEDBACK_MODEL` | repository/environment variable, optional | Defaults to `claude-sonnet-4-6` |

`DISCORD_BOT_TOKEN` is deliberately shared by the Gateway listener and the
workflow writer. Rotate it in both the Railway backend service and the
`discord-feedback` environment in the same maintenance window; either stale
copy will break one half of the command path.

The old scanner variables (`DISCORD_FEEDBACK_ENABLED`, channel lists, reaction
emoji, trigger keywords, and lookback windows) are ignored and can be removed
after rollout.

The `from-discord` label should already exist. If not:

```bash
gh label create from-discord --color 5865F2 --description "Filed from Discord user feedback"
```

## Rollout

1. Merge the workflow and backend code while `DISCORD_ISSUE_BOT_ENABLED=false`.
2. Install/configure the dedicated GitHub App and both allowlist copies.
3. Rename the Discord bot nickname to `Boardsesh Issues`.
4. Set `DISCORD_ISSUE_BOT_ENABLED=true` and redeploy the backend.
5. In a test thread, mention the bot and request one issue.
6. Confirm 👀 appears, the run succeeds, then ✅ and one issue link appear.
7. Mention it in a reply and as a standalone channel command to test both
   context modes.
8. Ask explicitly for two issues and confirm exactly two links are returned.

Audit results with:

```bash
gh issue list --repo boardsesh/boardsesh --label from-discord
```

## Local checks

Collect an already-existing command message by ID:

```bash
export DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=...
export DISCORD_ISSUE_TRIGGER_USER_IDS=...
vp run discord:feedback-scan -- \
  --mode collect \
  --channel-id 123 \
  --trigger-message-id 456 \
  --out /tmp/discord-bundle.json
```

After producing a decisions file, apply without writes:

```bash
export GITHUB_TOKEN=...
sha=$(sha256sum /tmp/discord-bundle.json | cut -d' ' -f1)
vp run discord:feedback-scan -- \
  --mode apply \
  --channel-id 123 \
  --trigger-message-id 456 \
  --bundle /tmp/discord-bundle.json \
  --decisions /tmp/discord-decisions.json \
  --bundle-sha256 "$sha" \
  --dry-run
```

## Privacy and attachments

`authorRef` is `sha256(guildId:authorId)` truncated to 12 hexadecimal
characters. Mentions and common secrets/PII are stripped before model access;
model output is redacted again before issue creation. Discord jump links remain
so maintainers can return to the discussion.

Image attachments are downloaded immediately and hosted on the existing
`discord-attachments` prerelease because signed Discord CDN URLs expire. This
publishes screenshots on the public tracker. The bot reply says when screenshots
were copied. Limits are four images per command context and 5 MB per image.

## Rollback

Set `DISCORD_ISSUE_BOT_ENABLED=false` and redeploy the backend. No scheduled scan
will take its place. Existing issues and their markers remain valid; re-enabling
does not recreate them.
