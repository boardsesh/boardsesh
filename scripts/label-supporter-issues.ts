/// <reference types="node" />

/**
 * Adds the `supporter` triage label to open issues by current GitHub sponsors
 * of the `boardsesh` org. Run weekly by refresh-acknowledgements.yml.
 *
 * Two tokens, so each holds only what it needs:
 * - SPONSORS_GH_TOKEN reads the org's sponsorships, private ones included
 *   (the Repo Bot App token with Organization Members: read).
 * - GH_TOKEN reads issues and writes labels (the job's GITHUB_TOKEN with
 *   issues: write).
 *
 * Usage: node --import tsx scripts/label-supporter-issues.ts [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import { labelSupporterIssues, type GithubGraphql } from './lib/supporter-issue-labels';

const OWNER = 'boardsesh';
const REPO = 'boardsesh';
const SPONSOR_ORG = 'boardsesh';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`::error::Missing ${name}.`);
    process.exit(1);
  }
  return value;
}

/** gh failed. Carries stdout (a GraphQL error body) but never the command line. */
class GhCallError extends Error {
  constructor(
    readonly exitStatus: number | null,
    readonly stdout: string,
  ) {
    super(`gh api call failed (exit ${exitStatus ?? 'unknown'}).`);
  }
}

function gh(token: string, args: string[]): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GH_TOKEN: token },
      // Keep gh's stderr out of the log: a failed call can echo an issue or login.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    // execFileSync's own message quotes the full command line, which carries
    // `author=<login>` or an issue number. Actions logs here are public.
    const failure = error as { status?: number | null; stdout?: unknown };
    throw new GhCallError(failure.status ?? null, typeof failure.stdout === 'string' ? failure.stdout : '');
  }
}

function graphqlWith(token: string): GithubGraphql {
  return (query, variables) => {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) args.push('-f', `${key}=${value}`);
    try {
      return JSON.parse(gh(token, args)) as unknown;
    } catch (error) {
      // gh exits non-zero on a GraphQL error but still prints the JSON body;
      // hand it back so the caller decides how much of the message to show.
      if (error instanceof GhCallError && error.stdout.trim()) {
        try {
          return JSON.parse(error.stdout) as unknown;
        } catch {
          // Not JSON: fall through to the sanitized error.
        }
      }
      throw error instanceof GhCallError ? error : new Error('gh api returned unreadable output.');
    }
  };
}

function main(): void {
  const sponsorsToken = requireEnv('SPONSORS_GH_TOKEN');
  const issuesToken = requireEnv('GH_TOKEN');
  const result = labelSupporterIssues({
    owner: OWNER,
    repo: REPO,
    sponsorOrg: SPONSOR_ORG,
    sponsorsGraphql: graphqlWith(sponsorsToken),
    issuesGraphql: graphqlWith(issuesToken),
    ensureLabel: (name, color) => {
      try {
        gh(issuesToken, [
          'api',
          '-X',
          'POST',
          `repos/${OWNER}/${REPO}/labels`,
          '-f',
          `name=${name}`,
          '-f',
          `color=${color}`,
        ]);
      } catch {
        // 422: the label exists, the usual case. Adding it to an issue creates it anyway.
      }
    },
    addLabel: (issueNumber, label) => {
      gh(issuesToken, [
        'api',
        '-X',
        'POST',
        `repos/${OWNER}/${REPO}/issues/${issueNumber}/labels`,
        '-f',
        `labels[]=${label}`,
      ]);
    },
    dryRun: process.argv.includes('--dry-run'),
    log: (line) => console.log(line),
  });
  if (result.failed > 0 || result.lookupsFailed > 0) {
    console.error(`::error::${result.failed} label writes and ${result.lookupsFailed} issue lookups failed.`);
    process.exit(1);
  }
}

main();
