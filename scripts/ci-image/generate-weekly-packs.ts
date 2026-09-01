/// <reference types="node" />

/**
 * git/filesystem driver for the prebaked CI image's history layering
 * (issue #5008). The pure math (week boundaries, tags, the pack-objects revlist
 * format) lives in ./weekly-packs.ts and is unit-tested there without any git
 * repo; this file is the thin, mostly-untested IO layer that shells out to git
 * and the filesystem on top of it.
 *
 * Three subcommands, composed by .github/workflows/ci-image.yml:
 *
 *   plan --baseline <YYYY-MM-DD> [--asof <YYYY-MM-DD>] [--existing-tags tag1,tag2,...]
 *     Prints JSON describing every completed week, the SINGLE next history
 *     layer that still needs building (baseline first if even that is
 *     missing, otherwise the earliest missing week) given the tags already
 *     published, and which tag the daily build should use as its history
 *     base. No git or network calls — pure date math, so the workflow can
 *     call this before checkout even finishes. The workflow loops this
 *     command (build what it returns, re-query the registry, call again)
 *     until `nextLayer` comes back `null`.
 *
 *   resolve-tip --before <YYYY-MM-DD> [--ref main] [--repo-root .]
 *     Prints the SHA of the last commit on `--ref` at or before 23:59:59 UTC
 *     on the given date. Requires full history (`fetch-depth: 0`).
 *
 *   pack --tip <sha> [--exclude <sha>] --out-dir <dir> --name <basename> [--repo-root .]
 *     Runs `git pack-objects --revs` with the exact stdin
 *     packObjectsRevListInput() builds, then renames git's SHA-suffixed
 *     output (`<basename>-<sha1>.pack`/`.idx`) to `<basename>.pack`/`.idx` so
 *     the Dockerfile can COPY a name it knows ahead of time.
 *
 * NEVER re-run `pack` for a week that has already been frozen and published —
 * see Dockerfile.ci's header comment for why a regenerated historical pack
 * would invalidate every layer built on top of it. This script does not
 * itself enforce that (it has no notion of "already published"); the
 * workflow enforces it by only ever calling `pack` for the week `plan`
 * reports as needing freezing, plus the always-regenerated current week.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  baselineTag,
  latestHistoryTag,
  nextHistoryLayer,
  packObjectsRevListInput,
  parseDateOnlyUTC,
  planCompletedWeeks,
  toDateOnlyUTC,
} from './weekly-packs';

function fail(message: string): never {
  console.error(`generate-weekly-packs: ${message}`);
  process.exit(1);
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) fail(`missing required --${name}`);
  return value;
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) fail(`unexpected positional argument ${JSON.stringify(arg)}`);
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`--${name} requires a value`);
    flags.set(name, value);
    index += 1;
  }
  return flags;
}

function runPlan(flags: Map<string, string>): void {
  const baselineDate = parseDateOnlyUTC(requireFlag(flags, 'baseline'));
  const asOf = flags.has('asof') ? parseDateOnlyUTC(requireFlag(flags, 'asof')) : new Date();
  // Baseline AND week tags share one namespace here -- see nextHistoryLayer's
  // doc comment for why the baseline's own existence has to be checked
  // before any week can be considered.
  const existingTags = new Set((flags.get('existing-tags') ?? '').split(',').filter((tag) => tag.length > 0));

  const completedWeeks = planCompletedWeeks(baselineDate, asOf);
  // `nextHistoryLayer` returns only the SINGLE next thing to build. The
  // workflow loops: build it, re-query the registry, call `plan` again — so
  // this prints one candidate per call, never a multi-step queue.
  const nextLayer = nextHistoryLayer(baselineDate, asOf, existingTags);
  const dailyHistoryBaseTag = latestHistoryTag(baselineDate, asOf, existingTags);

  console.log(
    JSON.stringify(
      {
        baselineDate: toDateOnlyUTC(baselineDate),
        baselineTag: baselineTag(baselineDate),
        completedWeeks: completedWeeks.map((week) => ({
          weekEndDate: toDateOnlyUTC(week.weekEndDate),
          tag: week.tag,
          historyBaseTag: week.historyBaseTag,
          exists: existingTags.has(week.tag),
        })),
        nextLayer,
        // Only trustworthy once nextLayer is null (i.e. baseline and every
        // completed week already exist) -- the daily build step checks that.
        dailyHistoryBaseTag,
      },
      null,
      2,
    ),
  );
}

function runResolveTip(flags: Map<string, string>): void {
  const before = parseDateOnlyUTC(requireFlag(flags, 'before'));
  const ref = flags.get('ref') ?? 'main';
  const repoRoot = resolve(flags.get('repo-root') ?? '.');

  const cutoff = `${toDateOnlyUTC(before)}T23:59:59Z`;
  const sha = execFileSync('git', ['log', '--before', cutoff, '-1', '--format=%H', ref], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();

  if (sha.length === 0) fail(`no commit on ${JSON.stringify(ref)} at or before ${cutoff}`);
  console.log(sha);
}

/** Directory entries matching `${name}-<anything>${extension}`, e.g. git's SHA-suffixed pack output. */
function findSuffixedOutput(directory: string, name: string, extension: string): string {
  const prefix = `${name}-`;
  const matches = readdirSync(directory).filter((entry) => entry.startsWith(prefix) && entry.endsWith(extension));
  if (matches.length !== 1) {
    fail(
      `expected exactly one ${JSON.stringify(`${prefix}*${extension}`)} in ${directory}, found ${matches.length}: ${matches.join(', ')}`,
    );
  }
  return matches[0];
}

function runPack(flags: Map<string, string>): void {
  const tip = requireFlag(flags, 'tip');
  const excludeTip = flags.get('exclude') ?? null;
  const outDir = resolve(requireFlag(flags, 'out-dir'));
  const name = requireFlag(flags, 'name');
  const repoRoot = resolve(flags.get('repo-root') ?? '.');

  if (!existsSync(outDir)) fail(`--out-dir ${outDir} does not exist`);
  // Fail loudly on a stale name collision rather than silently picking up a
  // leftover file from a previous run when we look for the SHA-suffixed
  // output below.
  const stalePrefix = `${name}-`;
  const staleEntries = readdirSync(outDir).filter(
    (entry) => entry.startsWith(stalePrefix) || entry === `${name}.pack` || entry === `${name}.idx`,
  );
  if (staleEntries.length > 0) {
    fail(`${outDir} already has output for ${JSON.stringify(name)}: ${staleEntries.join(', ')}`);
  }

  const stdinText = packObjectsRevListInput(tip, excludeTip);
  execFileSync('git', ['pack-objects', '--revs', join(outDir, name)], {
    cwd: repoRoot,
    input: stdinText,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  const packFile = findSuffixedOutput(outDir, name, '.pack');
  const idxFile = findSuffixedOutput(outDir, name, '.idx');
  renameSync(join(outDir, packFile), join(outDir, `${name}.pack`));
  renameSync(join(outDir, idxFile), join(outDir, `${name}.idx`));

  console.log(`Wrote ${join(outDir, `${name}.pack`)} and ${join(outDir, `${name}.idx`)}`);
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command) {
    case 'plan':
      runPlan(flags);
      return;
    case 'resolve-tip':
      runResolveTip(flags);
      return;
    case 'pack':
      runPack(flags);
      return;
    default:
      fail(`unknown command ${JSON.stringify(command)}; expected plan | resolve-tip | pack`);
  }
}

main();
