import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the deploy-side wiring for ../functions/_middleware.ts in
// .github/workflows/production-deploy.yml. The middleware is only worth anything
// if it actually ships: Pages discovers `functions/` relative to wrangler's cwd
// and refuses it inside the static root, and `_routes.json` has to reach the
// export or the Function silently runs on every request instead of the three
// asset prefixes.
//
// Same reasoning as production-deploy-hold.test.ts for living here: this reads
// the workflow via fs, which Vitest's `--changed` selection cannot relate to a
// diff of the file being read. ci.yml's `deploy-config` guard step runs this project
// unfiltered whenever production-deploy.yml changes.

const WORKFLOW_PATH = resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'production-deploy.yml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

/** The YAML body of a top-level job (keys at 2-space indent, bodies at 4+). */
function jobBlock(jobId: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === `  ${jobId}:`);
  if (start === -1) throw new Error(`production-deploy.yml has no \`${jobId}:\` job`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('    ')) break;
    body.push(line);
  }
  return body.join('\n');
}

const deployAppWeb = jobBlock('deploy-app-web');

describe('deploy-app-web ships the asset-404 Function', () => {
  it('copies _routes.json into the published export', () => {
    expect(deployAppWeb).toMatch(
      /cp deploy\/app-subdomain\/_routes\.json\s+"\$RUNNER_TEMP\/app-standalone\/_routes\.json"/,
    );
  });

  it('copies functions/ beside the export, never inside it', () => {
    // Cloudflare rejects a functions directory inside the static root, and a
    // copy into app-standalone/ would also publish the source as static files.
    expect(deployAppWeb).toMatch(/cp -R deploy\/app-subdomain\/functions\s+"\$RUNNER_TEMP\/functions"/);
    expect(deployAppWeb).not.toMatch(/deploy\/app-subdomain\/functions\s+"\$RUNNER_TEMP\/app-standalone/);
  });

  it('points wrangler at the directory holding functions/', () => {
    // Without --cwd, wrangler looks for `functions` in the repo root, finds
    // nothing, and deploys a static-only build — the Function silently vanishes.
    expect(deployAppWeb).toMatch(/--cwd "\$RUNNER_TEMP"/);
  });
});

describe('post-deploy smoke proves the entry chunk is JavaScript', () => {
  it('checks the content-type, not just the cache header', () => {
    // The regression that made a missing chunk invisible: `_headers` stamps
    // `immutable` on /_expo/* by path, so asserting only that passed even when
    // the SPA fallback answered with HTML.
    expect(deployAppWeb).toMatch(/content-type:\.\*javascript/);
    expect(deployAppWeb).toContain('check_entry_chunk_is_js');
  });

  it('no longer relies on the header-only check it replaced', () => {
    expect(deployAppWeb).not.toContain('check_hashed_asset_immutable');
  });
});

describe("deploy-app-web carries the previous deploys' chunks forward (#5780)", () => {
  const carryStep = 'node scripts/lib/carry-over-expo-web-chunks.mjs "$RUNNER_TEMP/app-standalone"';

  it('runs the carry-over script on the export with the agreed caps', () => {
    expect(deployAppWeb).toContain(carryStep);
    expect(deployAppWeb).toMatch(/--live https:\/\/app\.boardsesh\.com/);
    expect(deployAppWeb).toMatch(/--max-age-days 3\b/);
    expect(deployAppWeb).toMatch(/--max-files 4000\b/);
  });

  it('runs after the export checks and before the publish', () => {
    // Before the checks, carried files would count toward the baked-env grep;
    // after the publish, they would never ship.
    const carryIndex = deployAppWeb.indexOf(carryStep);
    const verifyIndex = deployAppWeb.indexOf('- name: Verify production origins');
    const publishIndex = deployAppWeb.indexOf('wrangler@4 pages deploy');
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(-1);
    expect(carryIndex).toBeGreaterThan(verifyIndex);
    expect(carryIndex).toBeLessThan(publishIndex);
  });

  it('can never fail or hold the deploy', () => {
    const stepStart = deployAppWeb.indexOf('id: carryover');
    const stepBody = deployAppWeb.slice(stepStart, deployAppWeb.indexOf(carryStep));
    expect(stepStart).toBeGreaterThan(-1);
    expect(stepBody).toMatch(/continue-on-error: true/);
    expect(stepBody).toMatch(/timeout-minutes: [1-5]\b/);
  });

  it("smoke-checks the previous deploy's entry chunk", () => {
    expect(deployAppWeb).toContain('PREVIOUS_ENTRY: ${{ steps.carryover.outputs.previous_entry }}');
    expect(deployAppWeb).toMatch(/retry "[^"]*previous deploy[^"]*"\s+check_previous_entry_chunk/);
  });
});
