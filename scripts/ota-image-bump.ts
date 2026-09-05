/// <reference types="node" />

/**
 * Find newer xprem releases and rewrite the repo onto one.
 *
 * The self-hosted OTA server has two halves that must move together: the `eoas`
 * CLI this repo publishes with (`EOAS_PACKAGE_SPEC` in scripts/lib/eoas.ts) and the
 * server image Railway runs (`OTA_SERVER_VERSION` in infra/railway/config.ts).
 * Upstream publishes both from the same release, so bumping them together is what
 * keeps the standing rule — the CLI may lead the server, never trail it — true by
 * construction.
 *
 * Two candidates are tracked, not one. A prerelease must never displace a stable
 * upgrade: `3.2.0-beta3` outranks `3.1.3` by semver, so a single "highest version"
 * search would quietly propose a beta and hide the stable release behind it. So the
 * highest stable and the highest prerelease ahead of the current version are
 * reported separately, and each becomes its own PR.
 *
 * Modes:
 *   (default)           Report the candidates. Human-readable.
 *   --json              The same, as JSON.
 *   --github-output     The same, as `key=value` lines for $GITHUB_OUTPUT.
 *   --write <version>   Rewrite every file that names the version onto <version>.
 *   --pr-body <version> Print the pull-request body for that bump.
 *
 * The last two exist so .github/workflows/ota-image-bump.yml stays a thin caller.
 * Generating a PR body in shell means a heredoc nested inside YAML with every
 * backtick escaped by hand — a quoting hazard that fails at 07:15 on a Monday. Here
 * it is ordinary code with a test.
 *
 * Usage:
 *   vp run ota:image-bump
 *   vp run ota:image-bump -- --json
 *   vp run ota:image-bump -- --write 3.1.3
 *
 * Network reads only, both unauthenticated: GHCR's tag list (via an anonymous pull
 * token) and the npm registry. No credentials, so this runs anywhere.
 *
 * See docs/railway.md and docs/mobile-ota-updates.md.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OTA_IMAGE_REPOSITORY, OTA_SERVER_VERSION } from '../infra/railway/config';
import { compareVersions } from '../infra/railway/plan';
import { EOAS_PACKAGE_SPEC } from './lib/eoas';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `ghcr.io/mercuretechnologies/expo-open-ota` -> `mercuretechnologies/expo-open-ota`. */
const GHCR_REPOSITORY = OTA_IMAGE_REPOSITORY.replace(/^ghcr\.io\//, '');

const NPM_PACKAGE = 'eoas';

/**
 * Every file that names the version, and what it names it as.
 *
 * This is the same set scripts/__tests__/eoas-version-parity.test.ts enforces. A
 * bump that misses one of these lands a PR that fails its own CI, so the list is
 * kept here rather than derived: a file added to the parity test must be added
 * here in the same change.
 */
const VERSION_BEARING_FILES = [
  'docs/mobile-ota-updates.md',
  'scripts/mobile-ota-setup.ts',
  'scripts/mobile-ota-rollback.ts',
  '.github/workflows/mobile-ota-backport.yml',
  'CLAUDE.md',
  'AGENTS.md',
  'scripts/lib/eoas.ts',
] as const;

export interface ReleaseCandidate {
  version: string;
  prerelease: boolean;
  imageTag: string;
  /** Whether a matching `eoas` release exists on npm. */
  cliAvailable: boolean;
}

export interface BumpReport {
  current: string;
  currentCli: string;
  stable: ReleaseCandidate | null;
  prerelease: ReleaseCandidate | null;
}

export interface CliOptions {
  json: boolean;
  githubOutput: boolean;
  write: string | null;
  prBody: string | null;
  help: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  let json = false;
  let githubOutput = false;
  let write: string | null = null;
  let prBody: string | null = null;
  let help = false;

  const takeVersion = (flag: string, value: string | undefined): string => {
    if (!value || value.startsWith('-')) throw new Error(`${flag} needs a version, e.g. ${flag} 3.1.3`);
    return value.replace(/^v/, '');
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    else if (argument === '--json') json = true;
    else if (argument === '--github-output') githubOutput = true;
    else if (argument === '--write') {
      write = takeVersion('--write', argv[index + 1]);
      index += 1;
    } else if (argument === '--pr-body') {
      prBody = takeVersion('--pr-body', argv[index + 1]);
      index += 1;
    } else if (argument === '--help' || argument === '-h') help = true;
    // Reject typos loudly rather than silently reporting when a write was meant.
    else throw new Error(`Unknown flag: ${argument} (see --help)`);
  }

  return { json, githubOutput, write, prBody, help };
}

/** A tag that is a plain `vX.Y.Z`, optionally with a prerelease suffix. */
const VERSION_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export function isPrerelease(version: string): boolean {
  return version.includes('-');
}

/**
 * Pick the newest stable and newest prerelease strictly ahead of `current`.
 *
 * Exported so the ordering can be tested against the real upstream tag list, which
 * mixes two prerelease spellings (`v3.0.0-beta.3` and `v3.1.2-beta2`) and carries
 * non-semver entries like `latest`.
 */
export function selectCandidates(
  tags: string[],
  current: string,
): { stable: string | null; prerelease: string | null } {
  const versions = tags
    .map((tag) => VERSION_TAG.exec(tag)?.[1])
    .filter((version): version is string => version !== undefined)
    .filter((version) => compareVersions(version, current) > 0);

  const newest = (candidates: string[]): string | null =>
    candidates.length === 0
      ? null
      : candidates.reduce((best, candidate) => (compareVersions(candidate, best) > 0 ? candidate : best));

  return {
    stable: newest(versions.filter((version) => !isPrerelease(version))),
    prerelease: newest(versions.filter(isPrerelease)),
  };
}

const GHCR_ORIGIN = 'https://ghcr.io';

/** Pages of tags to follow before giving up. 20 x 1000 tags is far past any real repository. */
const MAX_TAG_PAGES = 20;

/**
 * The `rel="next"` target of a registry `Link` header, resolved against the origin.
 *
 * Registries return a relative URI here, so it cannot be fetched as-is. Exported to
 * be tested directly: getting this wrong does not error, it silently truncates the
 * tag list — and the tags most likely to fall off the end are the newest ones,
 * which are the entire point of this script.
 */
export function nextTagPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(linkHeader);
  return match ? new URL(match[1], GHCR_ORIGIN).toString() : null;
}

/**
 * List the repository's tags from GHCR, following pagination.
 *
 * GHCR requires a bearer token even for a public image, but hands out an anonymous
 * one for the asking — so this needs no credential of ours.
 *
 * The paging is not currently load-bearing (upstream has ~25 tags against a 1000
 * page size) but the failure mode if it were needed is silent: a truncated list
 * looks exactly like "no newer release", and the script would report the repo as
 * up to date forever.
 */
export async function fetchImageTags(repository: string): Promise<string[]> {
  const tokenResponse = await fetch(
    `${GHCR_ORIGIN}/token?scope=${encodeURIComponent(`repository:${repository}:pull`)}&service=ghcr.io`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!tokenResponse.ok) throw new Error(`GHCR token request failed (HTTP ${tokenResponse.status}).`);
  const { token } = (await tokenResponse.json()) as { token?: string };
  if (!token) throw new Error('GHCR did not return an anonymous pull token.');

  const tags: string[] = [];
  let nextUrl: string | null = `${GHCR_ORIGIN}/v2/${repository}/tags/list?n=1000`;

  for (let page = 0; nextUrl && page < MAX_TAG_PAGES; page += 1) {
    const tagsResponse: Response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!tagsResponse.ok) throw new Error(`GHCR tag list failed (HTTP ${tagsResponse.status}).`);
    const body = (await tagsResponse.json()) as { tags?: string[] };
    tags.push(...(body.tags ?? []));
    nextUrl = nextTagPageUrl(tagsResponse.headers.get('link'));
  }

  return tags;
}

/** Every published version of the `eoas` CLI. */
export async function fetchCliVersions(packageName: string): Promise<Set<string>> {
  const response = await fetch(`https://registry.npmjs.org/${packageName}`, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`npm registry request failed (HTTP ${response.status}).`);
  const body = (await response.json()) as { versions?: Record<string, unknown> };
  return new Set(Object.keys(body.versions ?? {}));
}

export async function buildReport(current: string, currentCli: string): Promise<BumpReport> {
  const [tags, cliVersions] = await Promise.all([fetchImageTags(GHCR_REPOSITORY), fetchCliVersions(NPM_PACKAGE)]);
  const { stable, prerelease } = selectCandidates(tags, current);

  const toCandidate = (version: string | null): ReleaseCandidate | null =>
    version === null
      ? null
      : {
          version,
          prerelease: isPrerelease(version),
          imageTag: `${OTA_IMAGE_REPOSITORY}:v${version}`,
          cliAvailable: cliVersions.has(version),
        };

  return { current, currentCli, stable: toCandidate(stable), prerelease: toCandidate(prerelease) };
}

/**
 * Match `<prefix><version>` only where the version ENDS there.
 *
 * A plain substring replace would corrupt a longer version that merely starts with
 * this one: rewriting `3.1.2` to `3.1.3` would turn a `3.1.20` mention into
 * `3.1.30`. The trailing guard rejects anything that would extend the version — a
 * digit, a dot, or the hyphen that starts a prerelease.
 */
function versionPattern(prefix: string, version: string): RegExp {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escape(prefix)}${escape(version)}(?![0-9A-Za-z.\\-])`, 'g');
}

/**
 * Apply every version rewrite to one file's text.
 *
 * Pure and exported so the substring hazard above can be tested directly, rather
 * than only through a function that writes to the repo.
 */
export function rewriteVersionMentions(
  text: string,
  newVersion: string,
  oldVersion: string,
  oldCliVersion: string,
): string {
  return [
    { prefix: 'eoas@', from: oldCliVersion },
    { prefix: 'xprem:v', from: oldVersion },
    { prefix: 'expo-open-ota:v', from: oldVersion },
  ].reduce(
    (current, { prefix, from }) => current.replace(versionPattern(prefix, from), `${prefix}${newVersion}`),
    text,
  );
}

/**
 * Move the declared-server-version constant in infra/railway/config.ts.
 *
 * That constant is a bare string rather than one of the `eoas@`/`:v` spellings the
 * other files use, so it needs its own replacement. Pure and exported so the
 * pattern is pinned by a test: a rewrite that silently matched nothing would leave
 * config.ts on the old version while every other file moved — caught by the parity
 * test, but only after a bump PR had already been opened.
 */
export function rewriteServerVersionConstant(text: string, newVersion: string): string {
  return text.replace(/(export const OTA_SERVER_VERSION = ')[^']+(';)/, `$1${newVersion}$2`);
}

/**
 * Rewrite every file that names the version.
 *
 * Deliberately narrow replacements — exactly `eoas@<old>` and `<image>:v<old>` —
 * so a historical mention of an older release (which the parity test requires be
 * written as a bare version) is left untouched.
 */
export function writeVersion(newVersion: string, oldVersion: string, oldCliSpec: string): string[] {
  const touched: string[] = [];
  const oldCliVersion = oldCliSpec.replace(/^eoas@/, '');

  for (const relativePath of VERSION_BEARING_FILES) {
    const absolutePath = join(ROOT_DIR, relativePath);
    const before = readFileSync(absolutePath, 'utf-8');
    const after = [
      { prefix: 'eoas@', from: oldCliVersion },
      { prefix: 'xprem:v', from: oldVersion },
      { prefix: 'expo-open-ota:v', from: oldVersion },
    ].reduce((text, { prefix, from }) => text.replace(versionPattern(prefix, from), `${prefix}${newVersion}`), before);
    if (after !== before) {
      writeFileSync(absolutePath, after);
      touched.push(relativePath);
    }
  }

  // The deployed-version constant is a bare string, so it needs its own edit.
  const configPath = join(ROOT_DIR, 'infra/railway/config.ts');
  const configBefore = readFileSync(configPath, 'utf-8');
  const configAfter = rewriteServerVersionConstant(configBefore, newVersion);
  if (configAfter !== configBefore) {
    writeFileSync(configPath, configAfter);
    touched.push('infra/railway/config.ts');
  }

  return touched;
}

/**
 * The pull-request body for a bump.
 *
 * Lives here rather than in the workflow because the alternative is a heredoc
 * nested inside YAML with every backtick hand-escaped, which is a quoting hazard
 * that only shows up when the scheduled run fires. The `## Test plan`, `## Release
 * Notes` and `## Risk` sections are required by pr-test-plan.yml — a bump PR that
 * omits them fails its own CI.
 */
export function pullRequestBody(version: string, current: string): string {
  const prerelease = isPrerelease(version);

  return [
    `Moves the self-hosted OTA server from \`${current}\` to \`${version}\`, bumping the \`eoas\` CLI`,
    'pin and `OTA_SERVER_VERSION` in the same commit so the CLI never trails the server.',
    '',
    ...(prerelease
      ? [
          '> **This is a prerelease.** It is offered alongside the newest stable release, not',
          '> instead of it — check whether a stable bump PR is also open before merging this one.',
          '',
        ]
      : []),
    'Merging this is what applies it: `railway-drift.yml` rolls the new image on push to `main`,',
    'waits for the deployment, probes the server, and rolls back automatically if it does not',
    'answer.',
    '',
    `Release notes: https://github.com/mercuretechnologies/expo-open-ota/releases/tag/v${version}`,
    '',
    '## Test plan',
    '',
    '1. CI green.',
    '2. Open the Railway Config run on `main` → the probe step passes.',
    '3. Open https://updates.boardsesh.com/hc → loads blank, no error.',
    '4. Mobile app → force quit, reopen → an update downloads.',
    '',
    '## After it lands',
    '',
    `- Run \`vp dlx eoas@${version} doctor --channel=production\`.`,
    '- Re-check the ClickHouse `system.*_log` TTLs. A server image upgrade can recreate a log',
    '  table without one, and those logs outgrow the Observe data itself. See `docs/railway.md`.',
    '',
    '## Release Notes',
    '',
    'none',
    '',
    '## Risk',
    '',
    `Risk: 4/5 — moves the OTA server every shipped binary talks to.${prerelease ? ' Prerelease image.' : ''}`,
    '',
  ].join('\n');
}

/** `key=value` lines for a workflow to read into $GITHUB_OUTPUT. */
export function githubOutputLines(report: BumpReport): string[] {
  const lines = [`current=${report.current}`];
  for (const kind of ['stable', 'prerelease'] as const) {
    const candidate = report[kind];
    lines.push(`${kind}=${candidate?.version ?? ''}`);
    lines.push(`${kind}_cli=${candidate?.cliAvailable ? 'yes' : 'no'}`);
  }
  return lines;
}

function printHelp(): void {
  console.log(
    [
      'ota-image-bump — find newer xprem releases and rewrite the repo onto one.',
      '',
      '  vp run ota:image-bump                       report the candidates',
      '  vp run ota:image-bump -- --json             the same, as JSON',
      '  vp run ota:image-bump -- --github-output    the same, as key=value lines',
      '  vp run ota:image-bump -- --write 3.1.3      rewrite every file onto 3.1.3',
      "  vp run ota:image-bump -- --pr-body 3.1.3    print that bump's PR body",
      '',
      'Stable and prerelease candidates are reported separately, so a beta never',
      'displaces a stable upgrade. Reads GHCR and npm; no credentials needed.',
    ].join('\n'),
  );
}

function describe(label: string, candidate: ReleaseCandidate | null): string {
  if (!candidate) return `  ${label}: none newer`;
  const cli = candidate.cliAvailable ? '' : '  ** no matching eoas release on npm — cannot bump yet **';
  return `  ${label}: ${candidate.version}${cli}\n    image ${candidate.imageTag}`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  if (options.prBody) {
    // No network: the body is a pure function of the two versions, so this stays
    // usable when the registries are down and testable without stubbing them.
    console.log(pullRequestBody(options.prBody, OTA_SERVER_VERSION));
    return 0;
  }

  if (options.write) {
    const touched = writeVersion(options.write, OTA_SERVER_VERSION, EOAS_PACKAGE_SPEC);
    if (touched.length === 0) {
      console.log(`[ota-image-bump] Nothing to rewrite — already on ${options.write}.`);
      return 0;
    }
    console.log(`[ota-image-bump] Rewrote to ${options.write}:`);
    for (const file of touched) console.log(`  ${file}`);
    return 0;
  }

  const report = await buildReport(OTA_SERVER_VERSION, EOAS_PACKAGE_SPEC.replace(/^eoas@/, ''));

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  if (options.githubOutput) {
    for (const line of githubOutputLines(report)) console.log(line);
    return 0;
  }

  console.log(`[ota-image-bump] Deployed server ${report.current}, publishing with eoas ${report.currentCli}.`);
  console.log(describe('newest stable', report.stable));
  console.log(describe('newest prerelease', report.prerelease));
  return 0;
}

export { GHCR_REPOSITORY, NPM_PACKAGE, VERSION_BEARING_FILES };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[ota-image-bump] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
