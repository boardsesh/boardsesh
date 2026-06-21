/// <reference types="node" />

/**
 * Thin I/O wrapper around the pure Conventional-Commit validator
 * (scripts/lib/commit-message-transform.ts). Three modes:
 *
 *   Hook mode:  tsx scripts/check-commit-message.ts <path-to-commit-msg-file>
 *               Validates the first line of the file git wrote. Exit 1 on failure.
 *   CI range:   tsx scripts/check-commit-message.ts --range <BASE>..<HEAD>
 *               Validates every subject in the range, aggregating errors.
 *   PR title:   tsx scripts/check-commit-message.ts --pr-title "<title>"
 *               Validates a single subject (so PR-title category derivation is
 *               trustworthy).
 *
 * The local hook is best-effort (this repo's git worktrees make hooks
 * unreliable); the CI range check is the authoritative gate.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isSkippedSubject, validateCommitSubject } from './lib/commit-message-transform';

function reportSubject(subject: string, label: string): boolean {
  const result = validateCommitSubject(subject);
  if (result.ok) return true;
  console.error(`\n✖ ${label}: ${subject}`);
  for (const error of result.errors) console.error(`  - ${error}`);
  return false;
}

function checkRange(range: string): number {
  let output: string;
  try {
    output = execFileSync('git', ['log', '--format=%s', range], { encoding: 'utf8' });
  } catch (error) {
    console.error(`[commit-lint] could not read git range "${range}": ${String(error)}`);
    return 1;
  }
  const subjects = output.split('\n').filter((line) => line.trim().length > 0);
  let allValid = true;
  for (const subject of subjects) {
    if (isSkippedSubject(subject)) continue;
    if (!reportSubject(subject, 'commit')) allValid = false;
  }
  if (allValid) {
    console.log(`[commit-lint] ${subjects.length} commit(s) OK in ${range}.`);
    return 0;
  }
  console.error('\n[commit-lint] Fix the commit subjects above to the Conventional Commit format.');
  return 1;
}

function checkSingle(subject: string, label: string): number {
  if (reportSubject(subject, label)) {
    console.log(`[commit-lint] ${label} OK.`);
    return 0;
  }
  return 1;
}

function main(): void {
  const args = process.argv.slice(2);

  const rangeFlag = args.indexOf('--range');
  if (rangeFlag !== -1) {
    process.exitCode = checkRange(args[rangeFlag + 1] ?? '');
    return;
  }

  const prTitleFlag = args.indexOf('--pr-title');
  if (prTitleFlag !== -1) {
    process.exitCode = checkSingle(args[prTitleFlag + 1] ?? '', 'PR title');
    return;
  }

  // Hook mode: the first positional argument is the commit-message file path.
  const messagePath = args[0];
  if (!messagePath) {
    console.error('Usage: check-commit-message <commit-msg-file> | --range <BASE>..<HEAD> | --pr-title "<title>"');
    process.exitCode = 1;
    return;
  }

  let firstLine: string;
  try {
    firstLine = readFileSync(messagePath, 'utf8').split('\n')[0] ?? '';
  } catch (error) {
    console.error(`[commit-lint] could not read commit message file "${messagePath}": ${String(error)}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = checkSingle(firstLine, 'commit');
}

main();
