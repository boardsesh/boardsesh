# Discord feedback → GitHub issues

Reads user feedback out of the Boardsesh Discord and files it as deduplicated, labelled GitHub issues. Runs hourly in CI.

The third of three feedback→issue pipelines, alongside TestFlight (`scripts/testflight-feedback-to-issues.ts`) and in-app bug reports (`packages/backend/src/services/github-feedback.ts`). All three share `redactSensitiveText` from `@boardsesh/text-redaction` and the same marker-based dedup.

## What gets picked up

- **Every human message** in the always-feedback channels (`DISCORD_FEEDBACK_CHANNEL_IDS`, i.e. `#user-feedback`).
- **Any message anywhere else** the bot can see that someone reacted 🐛 to.
- **Any message with a thread** containing a trigger keyword (`bug`, `issue`, `file this`, `feature request`).

Bugs and feature requests become issues. Questions, praise, and chatter get the ✅ reaction and nothing else. Everything processed gets ✅; anything filed also gets a reply linking the issue.

## How it runs

```
collect (script)   →  bundle.json  →  triage (Claude, READ-ONLY)  →  decisions.json  →  apply (script)
Discord reads,        redacted        gh issue list/search/view       validated          GitHub + Discord
secrets, retries                      Read + Write(decisions) only    against bundle     writes
```

The split is deliberate. The triage step reads text typed by anyone who can click a public invite, so it holds **no write tools** — `--allowed-tools` is a UX guardrail, not a security boundary, and an agent with `gh issue create` plus attacker-controlled input is a prompt-injection hole. Its only output is a JSON file. The apply step re-validates every decision against the bundle it produced itself: an unknown `messageId` is dropped, a label outside the allowlist is dropped, HTML comments are stripped so the model cannot forge a marker. Worst case from a successful injection is a badly-worded draft issue, capped by `--max-issues`.

The file→react→reply ordering lives in tested TypeScript rather than in the skill prompt for the same reason: it is the correctness core, and agents skip steps.

| File | Role |
|---|---|
| `scripts/discord-feedback-scan.ts` | All Discord/GitHub I/O, retries, secrets, CLI |
| `scripts/lib/discord-feedback.ts` | Pure: snowflakes, emoji matching, triggers, noise, redaction shaping |
| `scripts/lib/discord-feedback-issue.ts` | Pure: marker, decision validation, issue body, replies |
| `.claude/skills/discord-feedback-triage/` | The classifier prompt + output schema |
| `.github/workflows/discord-feedback-issues.yml` | The scheduled job |
| `scripts/tsconfig.json` | Typechecks these files — repo-root `scripts/` had no CI typecheck before |

Root `scripts/` was never typechecked, so a broken type here would only have surfaced when the scheduled workflow failed at runtime. `vp run typecheck:scripts` now covers this pipeline and runs as part of the `typecheck` aggregate; widen its `include` as other scripts are made type-clean.

## One-time setup

### 1. Create the bot

Discord Developer Portal → New Application → Bot.

1. **Privileged Gateway Intents → MESSAGE CONTENT: ON.** Required even for REST reads. Without it `content` and `attachments` come back empty and the scanner sees an empty server. Self-serve under 100 servers. **This is the mistake everyone makes** — the collect step throws if more than half the messages it reads have no content, so a misconfigured intent fails the run loudly instead of silently finding nothing.
2. Leave Server Members Intent off; it isn't needed.
3. OAuth2 → URL Generator → scope `bot`, permissions: **View Channels, Read Message History, Add Reactions, Send Messages, Send Messages in Threads**.
4. Invite it to the guild.

### 2. Scope what it can read

The scanner reads **every channel the bot can see**, so channel permissions are the only thing limiting it. Deny the bot role on any private or mod channel you don't want scanned, and check category-level overrides — a category deny silently beats a guild-level grant. `DISCORD_EXCLUDE_CHANNEL_IDS` is a second belt, not the primary control.

Channel and guild ids need Developer Mode on (Discord → Settings → Advanced), then right-click → Copy ID.

### 3. Secrets and variables

Secrets (repo → Settings → Secrets → Actions):

| Name | Notes |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token from the portal |
| `CLAUDE_CODE_OAUTH_TOKEN` | Already exists, shared with `claude.yml` |

Variables (non-secret so they're auditable in the run log):

| Name | Default / example |
|---|---|
| `DISCORD_FEEDBACK_ENABLED` | `true` — the kill switch; the job skips entirely when unset |
| `DISCORD_GUILD_ID` | The Boardsesh guild id |
| `DISCORD_FEEDBACK_CHANNEL_IDS` | Comma-separated; the `#user-feedback` id |
| `DISCORD_EXCLUDE_CHANNEL_IDS` | Comma-separated; optional |
| `DISCORD_TRIGGER_EMOJI` | `🐛` (custom emoji: `name:id`) |
| `DISCORD_PROCESSED_EMOJI` | `✅` |
| `DISCORD_TRIGGER_KEYWORDS` | `bug,issue,file this,feature request` |

### 4. Provenance label

```bash
gh label create from-discord --color 5865F2 --description "Filed from Discord user feedback"
```

## Rollout

Merge with `DISCORD_FEEDBACK_ENABLED` unset first. `workflow_dispatch` only appears once the workflow is on the default branch and `schedule` only fires from it, so this cannot be iterated on from a PR branch.

1. **Dry run wide.** Dispatch with `dry_run: true`, `lookback_hours: 720`. Nothing is written anywhere. Download the artifact and read both files: `bundle.json` should contain no usernames and no raw `<@…>` mentions, and thread context should be present; `decisions.json` should match your own judgement. Iterate on the skill prompt here — this loop is free and safe.
2. **Small live run.** `dry_run: false`, `lookback_hours: 6`, `max_issues: 2`. Check the marker is the issue body's first line, labels applied, ✅ visible in Discord, reply posted, attachment renders, and the Source link opens the original message.
3. **Re-dispatch the same window immediately — it must file zero issues.** This is the test that both guards work.
4. Set `DISCORD_FEEDBACK_ENABLED=true` and watch the first few cron runs.
5. Audit with `gh issue list --label from-discord`.

## Idempotency

Two independent guards:

- **Primary — the ✅ reaction.** Read free from the message payload (`reactions[].me`), so checking costs no extra API call.
- **Backstop — the marker** `<!-- discord-feedback:<message_id> -->` on the issue body's first line, found via `repo:… is:issue "<marker>"`. GitHub search is the state store; there is no state file or cache.

Per message the order is `findIssueByMarker → ensureLabels → createIssue → addReaction → postReply`.

| Crash point | Next run sees | Outcome |
|---|---|---|
| before create | no reaction, no marker | re-triaged and filed; one wasted triage |
| create → react | no reaction, marker found | creation short-circuits; reacts + replies. **This is why the marker exists** |
| react → reply | reaction present | skipped; the reply is never posted |

That last row is a deliberate trade. Replying before reacting would turn a missing reply into a *duplicate* reply on every subsequent run, which is louder and worse.

## Privacy

The repo is public, so the issue body carries no identity — the same contract as `packages/backend/src/services/github-feedback.ts`.

- `buildCollectedMessage` builds from an explicit field list and never spreads the raw message, so a new Discord API field cannot start leaking identity on its own. Usernames, user ids, avatars, and nicknames are dropped.
- Reporters appear as `discord-<12 hex>` — `sha256(guildId:authorId)`. Enough to spot the same person across issues; an admin resolves the real identity privately.
- `stripDiscordMentions` runs before `redactSensitiveText`. It is the leak redaction alone misses: raw content carries `<@123456789012345678>`, a snowflake that resolves straight to an account.
- The model's own output is re-redacted in the apply step, since it may echo something that slipped through.
- The jump link stays in — it has no user id, the message is already readable by anyone with the invite, and it is what makes an issue actionable.

**Attachments are re-hosted, and that republishes user screenshots to a public repo.** Discord screenshots routinely contain usernames, emails, and DM sidebars, and redaction cannot read pixels. Mitigations: images only, at most 4 per message, 5 MB each, and the bot's reply tells the reporter their screenshot is on a public issue so they can ask for it to be pulled. If that trade stops being worth it, drop `uploadAttachment` and link the message instead.

Re-hosting uses **release assets** on a `discord-attachments` prerelease, not the issue body — GitHub has no API for attaching a file to an issue (the drag-and-drop uploader is web-only). Assets live outside git history, so the repo doesn't grow. Same mechanism `android-apk-rn.yml` uses for APKs.

## Noise control

Four layers, cheapest first:

1. **Structural** — skips bots, `webhook_id` posts (the deploy notifications), our own replies, and system message types.
2. **Guard** — skips anything already ✅'d.
3. **`isLikelyNoise()`** — under 12 characters, no letters at all, or on a small stoplist (`thanks`, `+1`, `lol`…). Runs before any model tokens are spent, so most chatter costs nothing.
4. **Classifier** — instructed to default to `noise` when uncertain.

Volume caps: `--max-messages` (50) on collect, `--max-issues` (5) on apply. **Over-cap messages are deliberately left unreacted** so the next run picks them up — a backlog drains gradually instead of dumping 40 issues at once.

## Running it locally

```bash
export DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... DISCORD_FEEDBACK_CHANNEL_IDS=...
vp run discord:feedback-scan -- --mode collect --out /tmp/bundle.json --lookback-hours 720

# triage by hand or with the skill, writing /tmp/decisions.json, then:
export GITHUB_TOKEN=...
vp run discord:feedback-scan -- --mode apply --bundle /tmp/bundle.json --decisions /tmp/decisions.json --dry-run
```

`--dry-run` on apply touches neither GitHub nor Discord.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Run fails with "MESSAGE CONTENT ... disabled" | The privileged intent is off in the Developer Portal |
| Collect finds nothing on a busy server | Bot can't see the channels — check role and category overrides |
| `Discord 403` for one channel | Normal for channels the bot isn't allowed in; it's logged and skipped |
| `Discord 401` | Bad or rotated token. Fails fast on purpose — repeated 401s get the runner IP Cloudflare-banned |
| Issues filed but no ✅ | Crash between filing and reacting; the next run recovers via the marker |
| Same issue filed twice | Should be impossible — check the marker is the body's first line and that search isn't lagging |
| Nothing runs at all | `DISCORD_FEEDBACK_ENABLED` is not `true` |

**Rollback:** set `DISCORD_FEEDBACK_ENABLED=false`. Emergency: revoke the bot token. Filed issues stay, and the ✅ reactions remain an accurate record of what was processed, so re-enabling never re-files.
