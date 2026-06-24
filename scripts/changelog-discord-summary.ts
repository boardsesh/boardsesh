/// <reference types="node" />

/**
 * Prints the "What's new" block for the OTA deploy Discord message: the changelog
 * entries newly added by this OTA run, grouped by category. Compares the changelog
 * committed BEFORE the run (`--prev`) with the one committed AFTER (`--next`) and
 * renders only the difference. Prints nothing when there's nothing new, so the
 * workflow can fall back to the triggering commit subject.
 *
 * Usage (from the OTA workflow):
 *   vp run changelog:discord-summary -- --prev <prev.json> --next <next.json> --out <out.md>
 *
 * Writes to `--out` (not stdout) so a `vp run` banner can't contaminate the file;
 * with no `--out` it prints to stdout. Degrades gracefully: an unreadable/malformed
 * file is treated as "no entries" (so a missing prior file yields the full new list,
 * and a missing next file yields an empty summary) and the script still exits 0 — it
 * must never break the deploy notification.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { buildDiscordSummary } from './lib/changelog-discord-summary';
import type { ChangelogEntry } from './lib/changelog-transform';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function readEntries(path: string | undefined): Pick<ChangelogEntry, 'prNumber' | 'category' | 'title'>[] {
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown };
    // Guard the shape too: a well-formed JSON whose `entries` isn't an array
    // (null, a primitive, an object) would otherwise reach the transform and throw
    // on `.filter`. Treat anything but an array as "no entries".
    return Array.isArray(parsed.entries) ? (parsed.entries as ChangelogEntry[]) : [];
  } catch {
    // Missing or malformed file → treat as no entries; the diff degrades safely.
    return [];
  }
}

const prevEntries = readEntries(argValue('--prev'));
const nextEntries = readEntries(argValue('--next'));
const summary = buildDiscordSummary(prevEntries, nextEntries);

const outPath = argValue('--out');
if (outPath) {
  writeFileSync(outPath, summary);
} else {
  process.stdout.write(summary);
}
