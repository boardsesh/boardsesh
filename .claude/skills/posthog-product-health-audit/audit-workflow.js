// Canonical implementation for the `posthog-product-health-audit` skill.
//
// Run it with the Workflow tool:
//   Workflow({ scriptPath: ".claude/skills/posthog-product-health-audit/audit-workflow.js" })
//
// It fans out four read-only PostHog MCP collectors, triages every candidate
// (classify -> adversarial refute -> mandatory dedup against existing GitHub
// issues), and returns drafted issue specs. It deliberately does NOT file
// anything — the calling session reviews `issueSpecs` and files with `gh`
// (see SKILL.md, "Phase 4 — File"). PostHog project id is read from `args`
// (default 412845) so the skill can target a different project without edits.

export const meta = {
  name: 'posthog-product-health-audit',
  description:
    'Audit Boardsesh PostHog telemetry (errors, recordings, analytics), verify and dedup findings, draft severity-labelled GitHub issue specs.',
  phases: [
    { title: 'Collect', detail: 'parallel PostHog MCP collectors: errors, analytics, recordings, web hygiene' },
    { title: 'Verify', detail: 'classify + severity, then adversarially refute each candidate' },
    { title: 'Dedup', detail: 'dedicated agent confirms each candidate is not an existing GH issue' },
    { title: 'Synthesize', detail: 'merge by root cause, draft issue specs + one hygiene issue' },
  ],
};

const PROJECT = args && args.project ? String(args.project) : '412845';
const REPO = args && args.repo ? String(args.repo) : 'boardsesh/boardsesh';
const LOOKBACK_DAYS = args && args.lookbackDays != null ? parseInt(args.lookbackDays, 10) : NaN;
const LOOKBACK = String(Number.isFinite(LOOKBACK_DAYS) && LOOKBACK_DAYS > 0 ? LOOKBACK_DAYS : 30); // positive integer days; 0/negative/non-numeric → 30

const MCP_PREAMBLE = `You are auditing Boardsesh's PostHog project (id ${PROJECT}, base https://us.posthog.com). To use PostHog: first call ToolSearch with query "select:mcp__posthog__exec" to load the tool, then drive it CLI-style via mcp__posthog__exec({command, context}). HARD RULE: run \`info <tool>\` before \`call <tool>\`, and for query-* tools drill \`schema <tool> <field>\` before populating array fields. Confirm any event name exists with \`call read-data-schema {"query":{"kind":"events"}}\` — never guess event names. The \`context\` arg must be 15-25 words, third person, no first person. Test accounts must be filtered out (filterTestAccounts/filter_test_accounts true).`;

const CONFIRMED_EVENTS = `Boardsesh custom events worth trending include: Bluetooth Connection Success/Failed, Bluetooth Disconnected, Pairing Failed, Climb Sent to Board Success/Failure, Tick Logged, Tick Save Failed, Quick Tick Saved/Failed, Queue Operation / Queue Operation Error, Climb Created / Climb Create Failed, Login Attempted/Succeeded/Failed, Signup Completed, Onboarding Tour Started/Completed/Skipped, Session Started/Joined/Ended, Board Render Error, Wall Confirmed, Wall Confirm Timeout, $rageclick, $dead_click, $exception, $csp_violation, $web_vitals, $pageview, $screen. Confirm each with read-data-schema before querying — the taxonomy drifts.`;

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'candidates'],
  properties: {
    source: { type: 'string' },
    context: { type: 'string', description: 'Freeform notes: metrics, rates, what was checked, what was clean.' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title', 'evidence'],
        properties: {
          key: { type: 'string', description: 'kebab-case stable slug' },
          title: { type: 'string' },
          platform: { type: 'string', description: 'ios | android | mobile | web | backend | unknown' },
          severityGuess: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          occurrences: { type: ['number', 'null'] },
          users: { type: ['number', 'null'] },
          sessions: { type: ['number', 'null'] },
          evidence: { type: 'string', description: 'stack frame / screen / URL / symptom / rate' },
          evidenceUrl: { type: ['string', 'null'], description: 'PostHog _posthogUrl or replay deep link' },
          sessionIds: { type: 'array', items: { type: 'string' } },
          suspectedAreaHint: { type: ['string', 'null'] },
        },
      },
    },
  },
};

phase('Collect');
const collectors = await parallel([
  () =>
    agent(
      `${MCP_PREAMBLE}

ROLE: Error-tracking collector. Enumerate production exceptions and capture enough evidence to file precise bug reports.
STEPS:
1. info then call query-error-tracking-issues-list {"status":"active","dateRange":{"date_from":"-${LOOKBACK}d"},"orderBy":"occurrences","orderDirection":"DESC","limit":50,"offset":0,"volumeResolution":0,"filterTestAccounts":true}.
2. Run it again adding "library":"posthog-js" to confirm whether WEB ($exception) errors exist as well as mobile (posthog-react-native). Report web coverage explicitly in context.
3. For the top ~8 DISTINCT root causes (merge issues that are obviously the same error), drill: info+call query-error-tracking-issue {"issueId":"<id>"} and query-error-tracking-issue-events {"issueId":"<id>","limit":3} to capture a representative stack frame, $current_url or $screen_name, $app_version / release, $lib (platform), and up to 3 $session_id values.
Return one candidate per distinct root cause with REAL fresh numbers, the _posthogUrl as evidenceUrl, the platform from $lib, and sessionIds. Set severityGuess: P0 crash/data-loss/security/total-blocker for many users; P1 core-flow bug (login broken, send-to-board fails, board list blocked); P2 noticeable w/ workaround; P3 cosmetic/long-tail/noise. Include noisy ones (user-cancel-as-error, dev-only leaks) too — they are triaged later.`,
      { label: 'collect:errors', phase: 'Collect', schema: CANDIDATE_SCHEMA },
    ),

  () =>
    agent(
      `${MCP_PREAMBLE}

ROLE: Analytics & failure-rate collector. Find product problems that show up as bad RATES or funnel drop-off, NOT raw counts — a growing site inflates absolute counts and bounce-rate by composition, so never flag those alone.
${CONFIRMED_EVENTS}
STEPS:
1. info+call web-analytics-weekly-digest {"compare":true,"days":${LOOKBACK}} for the macro picture.
2. Compute FAILURE RATES over -${LOOKBACK}d. The reliable path is execute-sql (run info execute-sql first): SELECT event, count() FROM events WHERE event IN ('Bluetooth Connection Failed','Bluetooth Connection Success','Climb Sent to Board Failure','Climb Sent to Board Success','Tick Save Failed','Tick Logged','Quick Tick Failed','Quick Tick Saved','Queue Operation Error','Climb Create Failed','Climb Created','Pairing Failed','Login Failed','Login Succeeded','Board Render Error','Wall Confirm Timeout','$rageclick','$dead_click') AND timestamp > now() - INTERVAL ${LOOKBACK} DAY GROUP BY event ORDER BY count() DESC. Confirm names via read-data-schema first; drop any that are absent.
3. Build funnels with query-funnel (drill schema query-funnel series first): Login Attempted -> Login Succeeded; Onboarding Tour Started -> Onboarding Tour Completed; Session Started -> Climb Sent to Board Success.
Return a candidate ONLY for a genuine product problem: a failure event whose rate vs its success counterpart is materially high (e.g. >10-15%), a funnel with surprising drop-off, or a rage/dead-click concentration. Put the computed rates and funnel conversions in context even when clean.`,
      { label: 'collect:analytics', phase: 'Collect', schema: CANDIDATE_SCHEMA },
    ),

  () =>
    agent(
      `${MCP_PREAMBLE}

ROLE: Session-recording collector. Find real user friction.
STEPS:
1. info+call query-session-recordings-list {"date_from":"-14d","filter_test_accounts":true,"properties":[{"key":"console_error_count","operator":"gt","type":"recording","value":0}],"order":"console_error_count","limit":15}.
2. Also list short high-click sessions (possible rage/confusion): order "click_count", date_from "-14d", limit 10.
3. Pick the ~5 highest-signal recordings and summarise each: info+call session-recording-summarize with the recording id, to extract what the user was trying to do and what broke.
Return a candidate for each distinct friction pattern you can substantiate from a summary (not speculation), with the replay deep link https://us.posthog.com/project/${PROJECT}/replay/<id> as evidenceUrl. If recordings are sparse or all clean, say so in context and return few/zero candidates.`,
      { label: 'collect:recordings', phase: 'Collect', schema: CANDIDATE_SCHEMA },
    ),

  () =>
    agent(
      `${MCP_PREAMBLE}

ROLE: Web hygiene collector (lighter pass).
${CONFIRMED_EVENTS}
STEPS: confirm events exist, then over -${LOOKBACK}d check: (a) $csp_violation volume and the top blocked directives/URIs (execute-sql group by the violation properties); (b) poor Core Web Vitals from $web_vitals (high LCP/CLS) by page; (c) $dead_click hotspots by $current_url/element.
Return a candidate only for a real, actionable web problem (a recurring CSP violation of one kind, a page with consistently bad LCP, or a dead-click hotspot on something users expect to be clickable). Put what you checked in context, including clean results.`,
      { label: 'collect:web-hygiene', phase: 'Collect', schema: CANDIDATE_SCHEMA },
    ),
]);

const valid = collectors.filter(Boolean);
const collectorContext = valid.map((c) => `### ${c.source}\n${c.context || '(no notes)'}`).join('\n\n');
const rawCandidates = valid.flatMap((c) => (c.candidates || []).map((x) => ({ ...x, source: c.source })));
log(`Collected ${rawCandidates.length} candidate problems across ${valid.length} sources`);

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['classification', 'severity', 'platform', 'reasoning'],
  properties: {
    classification: { type: 'string', enum: ['user-facing-bug', 'transient-infra', 'noise', 'expected-behavior'] },
    severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
    platform: { type: 'string' },
    suspectedFile: { type: ['string', 'null'] },
    fixAlreadyExists: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
};
const REFUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['keep', 'severity', 'reasoning'],
  properties: {
    keep: {
      type: 'string',
      enum: ['issue', 'hygiene', 'drop'],
      description:
        'issue=file a bug; hygiene=real but non-user-facing noise to bundle; drop=transient/expected/false/already-fixed',
    },
    severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
    reasoning: { type: 'string' },
  },
};
const DEDUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['duplicate', 'existingIssue', 'reasoning'],
  properties: {
    duplicate: { type: 'boolean' },
    existingIssue: { type: ['integer', 'null'] },
    relatedIssues: { type: 'array', items: { type: 'integer' } },
    reasoning: { type: 'string' },
  },
};

// Verify + Dedup are stages of one concurrent pipeline(). Per the Workflow
// guidance, pipeline stages pick their progress group via the per-agent `phase`
// option (set below), NOT a global phase() call — a global call would race
// across items running concurrently. That is why there is no phase('Dedup')
// here: the dedup agents are grouped by their { phase: 'Dedup' } option.
phase('Verify');
const triaged = await pipeline(
  rawCandidates,
  (c) =>
    agent(
      `Classify this Boardsesh telemetry finding for issue triage. You are in the Boardsesh monorepo working tree — use Bash (rg/ls) to grep packages/mobile, packages/web, packages/backend for the suspected code area and to check whether a guard/fix already exists.

FINDING (JSON):
${JSON.stringify(c, null, 2)}

Severity rubric: P0 crash/data-loss/security/total-blocker for many users; P1 core-flow bug or gap; P2 noticeable with a workaround; P3 cosmetic/long-tail/hygiene. Classifications: user-facing-bug (file it), transient-infra (single 502/504/DNS blips), noise (real but not user-facing — user cancels thrown as errors, dev/screenshot-only leaks), expected-behavior (e.g. "auth required" when logged out — confirm by reading code before assuming). Point suspectedFile at a real path when you can.`,
      { label: `classify:${c.key}`, phase: 'Verify', schema: CLASSIFY_SCHEMA },
    ).then((classify) => ({ ...c, classify })),

  (r) =>
    agent(
      `Adversarially review whether this finding deserves its own GitHub bug issue. Try to REFUTE it. Default to a lower keep level when uncertain.

FINDING + CLASSIFICATION (JSON):
${JSON.stringify(r, null, 2)}

Decide keep: "issue" only if it is a real, actionable, user-facing bug with enough evidence to act on; "hygiene" if real but non-user-facing noise (user-cancel-as-error, dev-only ReferenceError, log-spam) that should be bundled into one cleanup issue; "drop" if transient/infra, expected behaviour, unsubstantiated, or already fixed in the code. Adjust severity if the classifier over/under-rated it. Be skeptical of single-digit-occurrence infra blips and of metrics inflated by a traffic spike.`,
      { label: `verify:${r.key}`, phase: 'Verify', schema: REFUTE_SCHEMA },
    ).then((refute) => ({ ...r, refute })),

  (r) =>
    r.refute.keep === 'drop'
      ? r
      : agent(
          `DEDUP GATE. Confirm whether this finding is ALREADY tracked as a GitHub issue in ${REPO} before it gets filed. Use Bash gh.
PRIMARY (full-text, searches ALL issues regardless of age — use this first, with several keyword sets):
- gh search issues --repo ${REPO} "<keywords>" --state all --limit 100
FALLBACK / corroboration (note: --limit caps the result set, so always pair with --search and never rely on the default recency window):
- gh issue list --repo ${REPO} --state all --search "<keywords>" --limit 500
Try several keyword sets (the exact error string, the feature, the user-facing symptom). A low limit on a plain (unsearched) list silently returns only the most-recent issues and misses older duplicates — so search, do not just list.

FINDING (JSON):
${JSON.stringify({ key: r.key, title: r.title, evidence: r.evidence, platform: r.platform, classify: r.classify, refute: r.refute }, null, 2)}

Return duplicate=true ONLY if an existing issue clearly covers the same root cause (give its number as existingIssue). List merely-related issue numbers in relatedIssues. When unsure, duplicate=false (better a reviewed near-dup than a missed bug) but explain the closest match.`,
          { label: `dedup:${r.key}`, phase: 'Dedup', schema: DEDUP_SCHEMA },
        ).then((dedup) => ({ ...r, dedup })),
);

const triagedOk = triaged.filter(Boolean);
const toFile = triagedOk.filter((r) => r.refute?.keep === 'issue' && !r.dedup?.duplicate);
const hygiene = triagedOk.filter((r) => r.refute?.keep === 'hygiene' && !r.dedup?.duplicate);
const duplicates = triagedOk.filter((r) => r.dedup?.duplicate);
const dropped = triagedOk.filter((r) => r.refute?.keep === 'drop');
log(
  `To file: ${toFile.length} | hygiene-bundle: ${hygiene.length} | duplicates: ${duplicates.length} | dropped: ${dropped.length}`,
);

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title', 'body', 'labels', 'severity'],
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          body: {
            type: 'string',
            description:
              'Markdown. Symptom (climber voice) + Evidence (PostHog link, occurrences/users/sessions) + Suspected cause/file + Repro/notes + Severity rationale + Related issues.',
          },
          labels: { type: 'array', items: { type: 'string' } },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        },
      },
    },
    hygiene: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['title', 'body', 'labels'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

// Nothing survived triage (all dropped/deduped) → no synthesis agent to spawn.
let synth = { issues: [], hygiene: null };
if (toFile.length > 0 || hygiene.length > 0) {
  phase('Synthesize');
  synth = await agent(
    `Draft final GitHub issue specs for the ${REPO} repo from verified, non-duplicate findings. Merge any that share a root cause.

REAL BUGS TO FILE (JSON):
${JSON.stringify(toFile, null, 2)}

NOISE TO BUNDLE INTO ONE HYGIENE ISSUE (JSON):
${JSON.stringify(hygiene, null, 2)}

Rules:
- One issue per distinct root cause. Title in climber/plain voice describing what is broken (not the stack trace).
- Body markdown sections: **What's happening** (user-facing symptom), **Evidence** (PostHog _posthogUrl + occurrences/users/sessions over ${LOOKBACK}d, platform), **Suspected cause** (the suspectedFile if known), **Severity** (Px + one-line why), **Related** (relatedIssues numbers if any).
- labels: priority:<severity> plus "bug" plus "from-posthog" plus platform ("ios"/"android"/"mobile"/"web") as applicable. Only use labels from this set.
- If the NOISE list above is non-empty, build exactly ONE hygiene issue at P3 titled around "error-tracking hygiene" that bundles the noise items as a checklist (each: what to stop logging / guard, and where); labels priority:P3, from-posthog, plus platform if uniform. If the NOISE list is empty, set hygiene to null — do not invent a placeholder.
Return the spec. Do not file anything.`,
    { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA },
  );
}

return {
  collectorContext,
  counts: {
    collected: rawCandidates.length,
    toFile: toFile.length,
    hygiene: hygiene.length,
    duplicates: duplicates.length,
    dropped: dropped.length,
  },
  duplicates: duplicates.map((d) => ({
    key: d.key,
    title: d.title,
    existingIssue: d.dedup.existingIssue,
    reasoning: d.dedup.reasoning,
  })),
  dropped: dropped.map((d) => ({ key: d.key, title: d.title, reasoning: d.refute.reasoning })),
  triaged: triagedOk.map((r) => ({
    key: r.key,
    title: r.title,
    platform: r.platform,
    occurrences: r.occurrences,
    users: r.users,
    classify: r.classify,
    refute: r.refute,
    dedup: r.dedup,
    evidenceUrl: r.evidenceUrl,
    sessionIds: r.sessionIds,
  })),
  issueSpecs: synth,
};
