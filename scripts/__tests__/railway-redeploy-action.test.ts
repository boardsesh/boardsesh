/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ACTION_PATH = '.github/actions/railway-redeploy/action.yml';
const actionSource = readFileSync(ACTION_PATH, 'utf8');

describe('railway-redeploy rollback failure modes', () => {
  it('checks the GraphQL response body for errors, not just the HTTP status', () => {
    // GraphQL returns HTTP 200 even when the mutation is rejected (stale
    // deployment id, auth failure) — a bare `curl -fsS ... || echo` swallows
    // that and leaves production on the broken deployment with no signal.
    expect(actionSource).not.toMatch(/curl -fsS https:\/\/backboard\.railway\.com\/graphql\/v2/);
    expect(actionSource).toContain('ROLLBACK_RESPONSE=$(curl -sS https://backboard.railway.com/graphql/v2');
    expect(actionSource).toContain('Array.isArray(body.errors) && body.errors.length > 0');
  });

  it('fails the rollback step when the GraphQL call itself errors', () => {
    expect(actionSource).toMatch(/if ! ROLLBACK_RESPONSE=\$\(curl[\s\S]*?\); then/);
    expect(actionSource).toContain('Railway rollback request failed (network/HTTP error)');
  });

  it('fails the rollback step when the GraphQL body carries errors', () => {
    expect(actionSource).toContain('Railway rejected the rollback to');
  });

  it('treats CANCELLED as a terminal poll status alongside FAILED/CRASHED/REMOVED', () => {
    // Without this, a cancelled deployment falls through every case branch and
    // the poll exhausts all 90 attempts (15 minutes) before rolling back.
    expect(actionSource).toContain('FAILED|CRASHED|REMOVED|CANCELLED)');
  });

  it('never lets a rollback failure abort the step before the log capture', () => {
    // The poll step runs under `set -euo pipefail`. A bare
    // `rollback_previous_deployment` call aborts the step immediately on the
    // function's `return 1`, skipping the `railway logs` diagnostic capture
    // and the terminal `exit 1` below it.
    expect(actionSource).not.toMatch(/^\s*rollback_previous_deployment\s*$/m);
    // Excludes the `rollback_previous_deployment() {` definition line itself.
    const callSites = [...actionSource.matchAll(/^\s*rollback_previous_deployment(?!\(\))(.*)$/gm)];
    expect(callSites.length).toBeGreaterThan(0);
    for (const [, rest] of callSites) {
      expect(rest.trim()).toBe('|| true');
    }
  });
});
