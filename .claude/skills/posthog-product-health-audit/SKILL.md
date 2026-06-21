---
name: posthog-product-health-audit
description: Mine Boardsesh's PostHog telemetry (error tracking, session recordings, product analytics) with a multi-agent workflow, then file verified, deduplicated, severity-labelled GitHub issues. Use when asked to analyse PostHog errors/recordings/analytics, do a production-health or bug sweep, or turn telemetry into tracked issues. Project id 412845; repo boardsesh/boardsesh.
---

# PostHog product-health audit

Turns production telemetry into a short list of real, deduplicated bugs and files them as GitHub issues with the right severity. Built around the PostHog MCP (`mcp__posthog__exec`) and a four-phase `Workflow`. The canonical implementation lives next to this file: **`audit-workflow.js`**.

## When to use

- "Analyse our PostHog errors / recordings / analytics."
- "Do a production-health sweep / find bugs from telemetry."
- "Triage what users are hitting and open issues."

Read-only against PostHog. The only writes are the GitHub issues you create in Phase 4, plus a one-time `from-posthog` label.

## Run it

```
Workflow({ scriptPath: ".claude/skills/posthog-product-health-audit/audit-workflow.js" })
```

Optional `args`: `{ project, repo, lookbackDays }` — defaults (`412845` / `boardsesh/boardsesh` / `30`) live in `audit-workflow.js`; that file is the source of truth if these drift. The workflow returns structured findings and **drafts** issue specs — it does not file. You review `issueSpecs`, then file (Phase 4). This keeps a human checkpoint before anything lands on a public repo.

The workflow runs in the background; you get notified on completion. Watch live with `/workflows`.

## The four phases

**1 — Collect (4 parallel agents, PostHog MCP, read-only).** Each follows the schema-first discipline below.

- _Errors_ — `query-error-tracking-issues-list` (active, `-30d`, by occurrences, test accounts filtered), then `query-error-tracking-issue` + `query-error-tracking-issue-events` to pull stack frame, screen/URL, app version, `$lib` (platform), and `$session_id`s for the top ~8 root causes. Run a second pass with `library: "posthog-js"` — the top list skews mobile (`posthog-react-native`), so confirm web `$exception` coverage rather than assume it.
- _Analytics_ — `web-analytics-weekly-digest` for the macro picture, then **failure rates** (not raw counts) from `execute-sql` over paired events (`Bluetooth Connection Failed`/`…Success`, `Climb Sent to Board Failure`/`…Success`, `Tick Save Failed`/`Tick Logged`, …) and `query-funnel` for `Login Attempted→Succeeded`, `Onboarding Tour Started→Completed`, `Session Started→Climb Sent to Board Success`. A growing site inflates absolute counts and bounce-rate by composition — flag rates and drop-off, never raw jumps.
- _Recordings_ — `query-session-recordings-list` for `console_error_count > 0` and short high-click sessions, then `session-recording-summarize` on ~5 high-signal replays to get the user-facing symptom. Deep-link as `https://us.posthog.com/project/<id>/replay/<recording_id>`.
- _Web hygiene_ — `$csp_violation`, poor `$web_vitals` (LCP/CLS) by page, `$dead_click` hotspots.

**2 — Verify (pipeline per candidate).** `classify` (label + severity + suspected file via repo grep + whether a fix already exists) → `refute` (adversarial skeptic that tries to kill it; defaults to a lower keep level when uncertain). Each candidate ends as `issue`, `hygiene`, or `drop`.

**3 — Dedup gate (mandatory).** A dedicated dedup agent runs for **each** surviving candidate as the final stage of the verify `pipeline()` (so dedup for one finding overlaps verification of the next — no barrier). It searches **open and closed** issues (`gh issue list --search`, `gh search issues`) for the same root cause. `duplicate:true` candidates are recorded with a link and not filed; near-matches go in `relatedIssues`. When unsure, it errs toward `duplicate:false` (a reviewed near-dup beats a missed bug).

**4 — Synthesize → File.** One issue per root cause, climber-voice title, body = symptom + PostHog evidence link + occurrences/users/sessions + suspected file + severity rationale + related issues. Then create them with `gh` (see below).

## Severity rubric → labels

| Severity | Meaning                                                                           | Label         |
| -------- | --------------------------------------------------------------------------------- | ------------- |
| P0       | crash / data-loss / security / total blocker for many users                       | `priority:P0` |
| P1       | core-flow bug or gap (login broken, send-to-board fails, board list blocked)      | `priority:P1` |
| P2       | noticeable, has a workaround (e.g. a validation error, a _recurring_ 5xx pattern) | `priority:P2` |
| P3       | cosmetic / long-tail / hygiene                                                    | `priority:P3` |

Every filed issue also gets `bug`, the provenance label `from-posthog`, and a platform label (`ios` / `android` / `mobile` / `web`). Only use labels that already exist — check `gh label list`.

## Noise policy

Real-but-not-user-facing telemetry (user cancels thrown as errors, dev/screenshot-only `ReferenceError`s, log spam) is **not** filed one-per-item. The synthesis step rolls it into a single **P3 "error-tracking hygiene"** issue as a checklist (what to stop logging / guard, and where). When a run turns up no such noise, `issueSpecs.hygiene` is `null` — skip it, don't file a placeholder. Transient infra blips (a lone 502/504, a DNS miss) and expected behaviour (e.g. "auth required" when logged out — confirm in code first) are dropped, with the reason recorded.

## Filing (Phase 4)

```bash
# one-time provenance label, mirrors the existing from-sentry convention
gh label create from-posthog --color BFD4F2 --description "Filed from PostHog product telemetry" 2>/dev/null || true

# per issue, from issueSpecs.issues[]
gh issue create --repo boardsesh/boardsesh \
  --title "<title>" --body "<body>" \
  --label "priority:P1,bug,from-posthog,android"

# the single bundled hygiene issue from issueSpecs.hygiene
```

Afterwards print a summary: filed (`#`, title, severity), skipped-as-duplicate (→ existing `#`), skipped-as-noise/transient. Confirm with `gh issue list --label from-posthog`.

## PostHog MCP discipline (do not skip)

`mcp__posthog__exec` is CLI-style. The order is mandatory, like reading a file before editing it:

1. `search <regex>` or `info <tool>` to find the tool.
2. `info <tool>` **before every** `call <tool>`.
3. For `query-*` tools, `schema <tool> <field>` before populating array fields (e.g. `schema query-funnel series`).
4. Confirm every event/property name with `read-data-schema` (`kind: events` / `event_properties` / `event_property_values`) — names like `$pageview` still need confirming per project; the Boardsesh taxonomy drifts.
5. `call`s that touch collected data need a `context` arg: 15–25 words, third person.

Key tools: `query-error-tracking-issues-list`, `query-error-tracking-issue`, `query-error-tracking-issue-events`, `query-session-recordings-list`, `session-recording-summarize`, `web-analytics-weekly-digest`, `query-trends`, `query-funnel`, `execute-sql`, `read-data-schema`.

## Re-running

Safe to re-run on a schedule. The dedup gate keeps it from re-filing anything already tracked, so each run only surfaces genuinely new problems. Bump `lookbackDays` for a wider sweep; the first collector pass auto-discovers fresh top errors, so no seed list is needed.

**Watch-outs on re-run** (the pipeline logic isn't unit-tested — verify by eye):

- The dedup gate is keyword-driven `gh search`. On a large tracker, skim `issueSpecs` against `gh issue list --label from-posthog` before filing to confirm nothing already-tracked slipped through — especially issues phrased differently from the error string.
- A finding marked `keep: "drop"` skips dedup entirely (intended — dropped items are never filed). A finding marked `hygiene` that the dedup gate flags as a duplicate is excluded from the bundle and routed to `duplicates`.
- When every candidate is dropped/deduped, `issueSpecs` is `{ issues: [], hygiene: null }` and no synth agent runs — a clean run with nothing to file is a valid outcome, not an error.
