/**
 * Whether a test-plan step is written for the tester or for the author.
 *
 * The `## Test plan` section is not a record of how the change was verified —
 * it is rendered verbatim in the Boardsesh app, to someone holding a phone in a
 * gym with five minutes. That reader has no shell, no checkout, and no CI logs,
 * so a step that says "run vitest", "curl the header" or "read
 * docs/production-deploy.md" is dead weight to every person who will ever read
 * it. Author-side verification is worth writing down; it belongs in the
 * Summary, where reviewers read it.
 *
 * An internal change with genuinely nothing to tap says so in one step:
 * "1. CI green."
 */

/**
 * Binaries that only exist on a developer machine. A step naming one of these
 * is talking to the author, whatever the sentence around it says.
 */
const DEVELOPER_BINARIES =
  /\b(?:vp|pnpm|npx|bunx|vitest|jest|playwright|maestro|curl|wget|psql|drizzle-kit|tsx|ts-node|xcodebuild|gradlew|kubectl|terraform|ansible|adb)\b/i;

/**
 * Words that are a command in a command's position and ordinary English (or a
 * product, or a file format) everywhere else — "make a climb" and "make build"
 * are not the same sentence, and "the folder receives a SQLite file" is a real
 * thing a tester checks. Only flagged inside a backticked span or straight
 * after "run".
 */
const AMBIGUOUS_COMMANDS =
  /^(?:npm|bun|yarn|node|git|gh|op|make|ssh|railway|select|cd|cat|grep|sed|awk|docker|eas|expo|sqlite3)\b/i;

/** A backticked span: `vp run typecheck`. */
const BACKTICKED = /`([^`]+)`/g;

/** "Run `x`", "run the x command", "Re-run x". */
const RUN_PREFIX = /\b(?:re-?)?runs?\s+(?:the\s+)?[`'"]?([\w./-]+)/gi;

/**
 * A path into the repo: something with a slash and a source-file extension, or
 * one of the top-level directories. Deliberately excludes the extensions a
 * tester legitimately opens in a browser (`.xml`, `.html`, `.txt`), so
 * "open /sitemaps/climbs/1.xml" stays a valid step.
 */
const SOURCE_PATH =
  /\b[\w.@-]*\/?[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|sql|toml|lock|swift|kt|java|rb|py|sh)\b/;
const REPO_DIRECTORY = /\b(?:packages|scripts|infra|deploy|docs|embedded|fastlane|\.github|node_modules|src)\//;

export type StepVoiceProblem = {
  /** `command` — asks the tester to run something. `path` — points at the repo. */
  kind: 'command' | 'path';
  /** The offending text, for the error message. */
  quote: string;
};

/**
 * The first thing in `step` that only an author could act on, or null when the
 * step reads as something a tester can do.
 */
export function findDeveloperVoice(step: string): StepVoiceProblem | null {
  const binary = DEVELOPER_BINARIES.exec(step);
  if (binary) return { kind: 'command', quote: binary[0] };

  for (const [, inner] of step.matchAll(BACKTICKED)) {
    const command = AMBIGUOUS_COMMANDS.exec(inner.trim());
    if (command) return { kind: 'command', quote: inner.trim() };
  }

  for (const [, word] of step.matchAll(RUN_PREFIX)) {
    if (AMBIGUOUS_COMMANDS.test(word)) return { kind: 'command', quote: word };
  }

  const path = SOURCE_PATH.exec(step) ?? REPO_DIRECTORY.exec(step);
  if (path) return { kind: 'path', quote: path[0] };

  return null;
}

/** The gate's wording for one problem, written to teach the next author. */
export function describeDeveloperVoice(stepNumber: number, problem: StepVoiceProblem): string {
  const lead =
    problem.kind === 'command'
      ? `Step ${stepNumber} asks the tester to run "${problem.quote}".`
      : `Step ${stepNumber} points at the repo ("${problem.quote}").`;
  return `${lead} Testers read this plan on a phone — no shell, no checkout, no CI logs. Move author-side verification to the Summary, and write what a tester taps and sees. Nothing to tap? "1. CI green." is the whole plan.`;
}
