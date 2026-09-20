/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { githubYamlPaths, jobBlocks, isWorkflow } from './helpers/workflow-yaml';

/**
 * `.github/rulesets/main-require-ci-status.json` is the payload that makes
 * `ci-status` a required check on main (docs/ci-required-checks.md). It is
 * applied by hand, once, so nothing else in the repo ever reads it — which is
 * exactly why it needs a spec: every mistake it can contain is silent until it
 * is either useless or wedges the repo.
 *
 *   * a context naming a job that does not exist blocks EVERY PR forever, and
 *     the symptom ("Expected — waiting for status") is the same one the ruleset
 *     exists to produce, so it reads as working.
 *   * an unpinned context is satisfiable by any app that can write a status.
 *   * a bypass actor that no longer matches the app pushing to main either stops
 *     protecting (too broad) or breaks the OTA changelog push (missing).
 */

const RULESET_PATH = '.github/rulesets/main-require-ci-status.json';

/** GitHub Actions' global app id — the `app.id` on any actions-produced check suite. */
const GITHUB_ACTIONS_APP_ID = 15368;

/**
 * `boardsesh-repo-bot`, read from main's branch protection
 * (`required_pull_request_reviews.bypass_pull_request_allowances.apps[].id`).
 * It is the identity the workflows below push to main as.
 */
const REPO_BOT_APP_ID = 4098323;

type RequiredCheck = { context: string; integration_id?: number };
type Ruleset = {
  name: string;
  target: string;
  enforcement: string;
  bypass_actors: { actor_id: number; actor_type: string; bypass_mode: string }[];
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: {
    type: string;
    parameters?: {
      strict_required_status_checks_policy?: boolean;
      required_status_checks?: RequiredCheck[];
    };
  }[];
};

const ruleset = JSON.parse(readFileSync(RULESET_PATH, 'utf8')) as Ruleset;
const statusRule = ruleset.rules.find((rule) => rule.type === 'required_status_checks');
const requiredChecks = statusRule?.parameters?.required_status_checks ?? [];
const ciJobs = jobBlocks(readFileSync('.github/workflows/ci.yml', 'utf8'));

describe('the main required-checks ruleset payload', () => {
  it('requires ci-status and nothing else', () => {
    // One context, deliberately. `ci-status` already aggregates the workflow
    // (ci-status-rollup.test.ts pins that), so a second entry here would be a
    // second place to keep in sync. Adding one is a decision, not a detail.
    expect(requiredChecks.map((check) => check.context)).toEqual(['ci-status']);
  });

  it('names only contexts that are real jobs in ci.yml', () => {
    // A typo here is unrecoverable-looking: the context is never reported, so
    // every PR sits at "Expected — waiting for status" indefinitely.
    const unknown = requiredChecks.filter((check) => !ciJobs.has(check.context));
    expect(unknown).toEqual([]);
  });

  it('pins every context to the GitHub Actions app', () => {
    // Unpinned, the context is satisfied by whatever wrote a status with that
    // name — including a status posted by hand with a token.
    for (const check of requiredChecks) {
      expect(check.integration_id).toBe(GITHUB_ACTIONS_APP_ID);
    }
  });

  it('targets main only, so the tag ruleset is untouched', () => {
    expect(ruleset.target).toBe('branch');
    expect(ruleset.conditions.ref_name.include).toEqual(['refs/heads/main']);
    expect(ruleset.conditions.ref_name.exclude).toEqual([]);
  });

  it('is active rather than evaluate-only', () => {
    // `evaluate` logs what it would have blocked and blocks nothing — the exact
    // soft gate #4758 is about.
    expect(ruleset.enforcement).toBe('active');
  });

  it('does not require branches to be up to date', () => {
    // `strict` would force a rebase on every push to main. The roll-up answers
    // "is this commit verified", not "is it verified against this minute's main".
    expect(statusRule?.parameters?.strict_required_status_checks_policy).toBe(false);
  });

  it('lets the app that pushes to main bypass', () => {
    expect(ruleset.bypass_actors).toEqual([
      { actor_id: REPO_BOT_APP_ID, actor_type: 'Integration', bypass_mode: 'always' },
    ]);
  });

  it('still has workflows that push to main as that app', () => {
    // The bypass is only justified while something actually needs it. These
    // commits carry [skip ci], so no CI run — and no ci-status check — can ever
    // exist on them; without the bypass the push is rejected. If this list ever
    // empties, drop the bypass_actors entry instead of leaving a hole.
    const pushers = githubYamlPaths()
      .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
      .filter(
        ({ source }) =>
          isWorkflow(source) && source.includes('git push origin HEAD:main') && source.includes('OTA_PUSH_APP_ID'),
      )
      .map(({ path }) => path);

    expect(pushers.length).toBeGreaterThan(0);
  });
});
