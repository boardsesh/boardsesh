/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = '.github/workflows/production-deploy.yml';
const DOCKERFILE_PATH = 'Dockerfile.web';
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');
const dockerfileSource = readFileSync(DOCKERFILE_PATH, 'utf8');

/**
 * Return one YAML mapping entry by exact key and indentation. Copied from
 * ci-docker-web-workflow.test.ts as that file instructs: the repo declares no
 * YAML parser, and a CI contract test is not worth the dependency churn.
 */
function mappingEntry(source: string, key: string, indentation: number): string {
  const lines = source.split('\n');
  const prefix = `${' '.repeat(indentation)}${key}:`;
  const startIndex = lines.findIndex((line) => line.startsWith(prefix));
  if (startIndex < 0) {
    throw new Error(`missing ${key} mapping at indentation ${indentation}`);
  }

  let endIndex = lines.length;
  for (let lineIndex = startIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const lineIndentation = line.length - line.trimStart().length;
    if (lineIndentation <= indentation) {
      endIndex = lineIndex;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

/** Strip `#` comment lines so a job's rationale can never satisfy an assertion. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * Every JOB-level `if:` in the workflow — the `if:` at indentation 4 under a job
 * key, plus its wrapped continuation lines. Step-level `if:` sits at 8 and is
 * deliberately excluded: the whole point of the distinction is that only the
 * job-level one is evaluated before an environment is attached.
 */
function jobLevelIfBlocks(source: string): string[] {
  const lines = withoutComments(source).split('\n');
  const blocks: string[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!/^ {4}if:/.test(lines[lineIndex])) continue;
    const block = [lines[lineIndex]];
    for (let nextIndex = lineIndex + 1; nextIndex < lines.length; nextIndex += 1) {
      const line = lines[nextIndex];
      if (!line.trim()) continue;
      const indentation = line.length - line.trimStart().length;
      if (indentation <= 4) break;
      block.push(line);
    }
    blocks.push(block.join('\n'));
  }

  return blocks;
}

/** One `- name: <name>` step out of a job block, comments stripped. */
function stepNamed(jobSource: string, name: string): string {
  const lines = withoutComments(jobSource).split('\n');
  const startIndex = lines.findIndex((line) => line.trimStart() === `- name: ${name}`);
  if (startIndex < 0) throw new Error(`missing step "${name}"`);

  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && (/^ {6}- /.test(line) || (line.trim() !== '' && !line.startsWith('      '))),
  );
  return lines.slice(startIndex, endIndex < 0 ? lines.length : endIndex).join('\n');
}

const VERCEL_GATE = "if: needs.resolve-web-targets.outputs.web_vercel == 'true'";

describe('production-deploy web deploy targets', () => {
  const resolverJob = withoutComments(mappingEntry(workflowSource, 'resolve-web-targets', 2));
  const checkRollbackJob = withoutComments(mappingEntry(workflowSource, 'check-rollback', 2));
  const buildWebJob = withoutComments(mappingEntry(workflowSource, 'build-web', 2));
  const migrateJob = withoutComments(mappingEntry(workflowSource, 'migrate', 2));
  const deployWebJob = withoutComments(mappingEntry(workflowSource, 'deploy-web', 2));
  const deployWebRailwayJob = withoutComments(mappingEntry(workflowSource, 'deploy-web-railway', 2));
  const deployBackendJob = withoutComments(mappingEntry(workflowSource, 'deploy-production-backend', 2));

  it('never reads WEB_DEPLOY_TARGETS from a job-level if', () => {
    // The whole reason resolve-web-targets is a job. A job-level `if:` is
    // evaluated before the Production environment is attached, so `vars.` there
    // sees repository variables only — an environment-scoped WEB_DEPLOY_TARGETS
    // would silently read as empty and every run would deploy to Vercel,
    // including one an operator had deliberately switched to Railway.
    for (const block of jobLevelIfBlocks(workflowSource)) {
      expect(block).not.toContain('vars.WEB_DEPLOY_TARGETS');
    }
    // And it is read in exactly one place: the resolver's step env.
    const occurrences = withoutComments(workflowSource).match(/vars\.WEB_DEPLOY_TARGETS/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(resolverJob).toContain('WEB_DEPLOY_TARGETS: ${{ vars.WEB_DEPLOY_TARGETS }}');
  });

  it('resolves the targets inside the Production environment and publishes them', () => {
    expect(resolverJob).toContain('environment: Production');
    expect(resolverJob).toContain('run: node scripts/production-web-deploy-targets.mjs');
    expect(resolverJob).toContain('RAILWAY_WEB_SERVICE_ID: ${{ vars.RAILWAY_WEB_SERVICE_ID }}');
    expect(resolverJob).toContain('RAILWAY_WEB_ORIGIN: ${{ vars.RAILWAY_WEB_ORIGIN }}');
    for (const output of ['web_vercel', 'web_railway', 'web_targets']) {
      expect(resolverJob).toContain(`${output}: \${{ steps.resolve.outputs.${output} }}`);
    }
  });

  it('short-circuits the Vercel rollback probe at step level, not by skipping the job', () => {
    // build-backend's gate has no `always()`, so a job-level skip of
    // check-rollback would cascade into skipping the backend build and every
    // deploy behind it — a web setting quietly switching off the backend
    // release. Writing active=false keeps the job `success`.
    expect(checkRollbackJob).toContain('needs: [resolve-web-targets]');
    expect(checkRollbackJob).toContain('WEB_VERCEL: ${{ needs.resolve-web-targets.outputs.web_vercel }}');
    expect(checkRollbackJob).not.toMatch(/^ {4}if:/m);

    const shortCircuitIndex = checkRollbackJob.indexOf('echo "active=false"');
    const curlIndex = checkRollbackJob.indexOf('curl -sS -o response.json');
    expect(shortCircuitIndex).toBeGreaterThan(-1);
    expect(curlIndex).toBeGreaterThan(-1);
    expect(shortCircuitIndex).toBeLessThan(curlIndex);
  });

  it('leaves the migrate gate exactly as it was', () => {
    // The image build lives inside build-web rather than in a sibling job
    // precisely so this gate keeps meaning what it meant. A parallel PR (#4849)
    // owns this job; if that lands first, reconcile deliberately.
    expect(migrateJob).toContain('needs: [detect-changes, build-web, build-backend, sync-static-assets]');
    expect(migrateJob).toContain("!(needs.build-web.result == 'skipped' && needs.build-backend.result == 'skipped')");
  });

  it('gates every Vercel step in build-web on the resolved target', () => {
    for (const stepName of [
      'Install Vercel CLI',
      'Pull Vercel project settings (production)',
      'Build with Vercel (prebuilt output)',
      'Package prebuilt output',
      'Upload prebuilt output',
    ]) {
      expect(stepNamed(buildWebJob, stepName), stepName).toContain(VERCEL_GATE);
    }
  });

  it('publishes the web image regardless of which deployer is selected', () => {
    // The image is the artifact: pushing it is free and reversible, and it is
    // what makes a later `railway redeploy` possible without a rebuild. Gating
    // it would also make merging this wiring a production change instead of a
    // no-op. Every one of these steps must be unconditional.
    for (const stepName of [
      'Log in to GHCR',
      'Set up Docker Buildx',
      'Extract web image metadata',
      'Generate web Docker context',
      'Build and push web image',
      'Generate web artifact attestation',
    ]) {
      expect(stepNamed(buildWebJob, stepName), stepName).not.toContain('if:');
    }
  });

  it('builds the generated context, pushes it, and attests it', () => {
    expect(buildWebJob).toContain('run: vp run docker-context:web');
    expect(buildWebJob).toContain('context: .docker-context/web');
    expect(buildWebJob).toContain('file: .docker-context/web/Dockerfile');
    expect(buildWebJob).toContain('push: true');
    expect(buildWebJob).toContain('attest-build-provenance');
    // Pushing to GHCR and attesting both need scopes the default token lacks.
    expect(buildWebJob).toContain('packages: write');
    expect(buildWebJob).toContain('attestations: write');
    expect(buildWebJob).toContain('id-token: write');
    // Downstream reads these to name the image it is deploying.
    expect(buildWebJob).toContain(
      'image: ${{ env.REGISTRY }}/${{ github.repository_owner }}/${{ env.WEB_IMAGE_NAME }}',
    );
    expect(buildWebJob).toContain('digest: ${{ steps.build.outputs.digest }}');
  });

  it('bakes every production client value into the image', () => {
    // Each of these is inlined into the client bundle at build time, so this
    // list IS the production client config. NEXT_PUBLIC_POSTHOG_KEY went missing
    // from the Vercel build once and took all client analytics with it.
    for (const buildArg of [
      "NEXT_PUBLIC_WS_URL=${{ vars.NEXT_PUBLIC_WS_URL || 'wss://ws.boardsesh.com/graphql' }}",
      'BASE_URL=https://www.boardsesh.com',
      'BOARDSESH_WEB=1',
      'NEXT_PUBLIC_POSTHOG_KEY=${{ vars.NEXT_PUBLIC_POSTHOG_KEY }}',
      'NEXT_PUBLIC_STATIC_ASSET_BASE_URL=https://assets.boardsesh.com',
      'SENTRY_RELEASE=${{ github.sha }}',
    ]) {
      expect(buildWebJob, buildArg).toContain(buildArg);
    }
  });

  it('passes the Sentry token as a build secret, never a build-arg', () => {
    // An ARG's value is recorded in the image history, so `docker history` on a
    // published image would hand out the token.
    expect(mappingEntry(buildWebJob, 'secrets', 10)).toContain('SENTRY_AUTH_TOKEN=${{ secrets.SENTRY_AUTH_TOKEN }}');
    expect(mappingEntry(buildWebJob, 'build-args', 10)).not.toContain('SENTRY_AUTH_TOKEN');
    expect(dockerfileSource).not.toMatch(/^ARG SENTRY_AUTH_TOKEN$/m);
    expect(dockerfileSource).toContain('--mount=type=secret,id=SENTRY_AUTH_TOKEN');
  });

  it('declares every build-arg it passes in the Dockerfile builder stage', () => {
    // Docker silently IGNORES a build-arg the Dockerfile never declares — no
    // warning that fails a build, no missing-value error at runtime, just a
    // client bundle built without it. Derived from the workflow rather than
    // pinned, so a new build-arg is checked against reality.
    const buildArgsBlock = mappingEntry(buildWebJob, 'build-args', 10);
    const passedKeys = [...buildArgsBlock.matchAll(/^\s+([A-Z][A-Z0-9_]*)=/gm)].map(([, key]) => key);
    expect(passedKeys.length).toBeGreaterThan(3);

    const builderStage = dockerfileSource.slice(
      dockerfileSource.indexOf('AS builder'),
      dockerfileSource.indexOf('AS runner'),
    );
    const undeclared = passedKeys
      .filter((key) => key.startsWith('NEXT_PUBLIC_') || key === 'SENTRY_RELEASE')
      .filter((key) => !new RegExp(`^ARG ${key}$`, 'm').test(builderStage));

    expect(undeclared, `build-args with no ARG in ${DOCKERFILE_PATH}'s builder stage`).toEqual([]);
  });

  it('reads the shared buildx cache but never writes it', () => {
    // Writing `web-main` costs 2.72 GB against a repo cache measured at 9.15 GB
    // of GitHub's 10 GB ceiling, evicting the gradle and vp toolchain caches
    // that serve mobile PRs to save ~90 s on a once-per-merge job.
    expect(buildWebJob).toContain('cache-from: type=gha,scope=web-main');
    expect(buildWebJob).not.toContain('cache-to');
  });

  it('gates the Vercel deploy on the resolved target', () => {
    expect(deployWebJob).toContain("needs.resolve-web-targets.outputs.web_vercel == 'true'");
    expect(deployWebJob).toContain('resolve-web-targets');
  });

  it('gates the Railway web deploy behind the same release gates as Vercel', () => {
    expect(deployWebRailwayJob).toContain("needs.resolve-web-targets.outputs.web_railway == 'true'");
    // migrate especially: a web container that boots against an unmigrated DB is
    // the failure the whole gate chain exists to prevent.
    expect(deployWebRailwayJob).toContain('migrate');
    expect(deployWebRailwayJob).toContain("needs.migrate.result == 'success'");
    expect(deployWebRailwayJob).toContain("needs.build-web.result == 'success'");
    expect(deployWebRailwayJob).toContain('environment: Production');
  });

  it('redeploys the Railway web service through the shared composite action', () => {
    expect(deployWebRailwayJob).toContain('uses: ./.github/actions/railway-redeploy');
    expect(deployWebRailwayJob).toContain('service-id: ${{ vars.RAILWAY_WEB_SERVICE_ID }}');
    expect(deployWebRailwayJob).toContain('railway-token: ${{ secrets.RAILWAY_TOKEN }}');
    expect(deployWebRailwayJob).toContain('service-label: web');
  });

  it('smokes the Railway origin, softly while Vercel still serves www', () => {
    // A detector, not a gate, while Vercel serves traffic — and a hard gate the
    // moment Railway is the only target. The expression flips on its own.
    expect(deployWebRailwayJob).toContain('run: node scripts/production-smoke.ts --base "$RAILWAY_WEB_ORIGIN"');
    expect(deployWebRailwayJob).toContain(
      "continue-on-error: ${{ needs.resolve-web-targets.outputs.web_vercel == 'true' }}",
    );
    expect(deployWebRailwayJob).toContain('RAILWAY_WEB_ORIGIN: ${{ vars.RAILWAY_WEB_ORIGIN }}');
    expect(deployWebRailwayJob).not.toContain('Note the missing smoke origin');
  });

  it('keeps a single Railway promote path', () => {
    // A second inline copy is how the two services drift: one gets a poll fix,
    // the other keeps the bug.
    expect(deployBackendJob).toContain('uses: ./.github/actions/railway-redeploy');
    expect(deployBackendJob).not.toMatch(/^\s*railway\s+redeploy\b/m);
    expect(withoutComments(workflowSource)).not.toMatch(/^\s*railway\s+redeploy\b/m);
  });

  it('announces a held web deploy instead of leaving a grey skip', () => {
    const heldJob = withoutComments(mappingEntry(workflowSource, 'notify-web-held', 2));
    expect(heldJob).toContain("needs.resolve-web-targets.outputs.web_targets == 'none'");
    expect(heldJob).toContain("needs.build-web.result == 'success'");
    expect(heldJob).toContain('DISCORD_DEPLOY_WEBHOOK');
    expect(heldJob).toContain('WEB_DEPLOY_TARGETS=none');
  });

  it('reports the Railway web deploy in both Discord notifications', () => {
    // notify-failure's `contains(needs.*.result, 'failure')` only covers jobs it
    // lists, so a Railway deploy that failed while nothing else did would be
    // completely silent without this.
    for (const jobName of ['notify-failure', 'notify-success']) {
      // The `needs:` LIST specifically, not the job text: both jobs also name
      // deploy-web-railway in their `if:` and env, so a whole-job `toContain`
      // stays green on a job that dropped the dependency and can no longer see
      // its result.
      const notifyNeeds = mappingEntry(withoutComments(mappingEntry(workflowSource, jobName, 2)), 'needs', 4);
      expect(notifyNeeds, jobName).toContain('deploy-web-railway');
      expect(notifyNeeds, jobName).toContain('resolve-web-targets');
    }
    const successJob = withoutComments(mappingEntry(workflowSource, 'notify-success', 2));
    expect(successJob).toContain("needs.deploy-web-railway.result == 'success'");
    expect(successJob).toContain('deployed (Vercel + Railway)');
    expect(successJob).toContain('deployed (Railway)');
  });

  it('fails the web image build when the PostHog key is empty', () => {
    // The GHCR image is UNGATED by WEB_DEPLOY_TARGETS (always builds), so a
    // missing key here would silently ship a Railway image with client
    // analytics disabled — unlike the Vercel path, nothing else catches it.
    const guardStep = stepNamed(buildWebJob, 'Require a PostHog key for the web image build');
    expect(guardStep).toContain('NEXT_PUBLIC_POSTHOG_KEY: ${{ vars.NEXT_PUBLIC_POSTHOG_KEY }}');
    expect(guardStep).toContain('vars.NEXT_PUBLIC_POSTHOG_KEY is unset');
    expect(guardStep).toContain('exit 1');
    // Must run before the image build actually consumes the var.
    expect(buildWebJob.indexOf('Require a PostHog key for the web image build')).toBeLessThan(
      buildWebJob.indexOf('name: Build and push web image'),
    );
  });

  it('warns Discord when the Railway smoke fails while Vercel still serves www', () => {
    // continue-on-error keeps the job green in the dual-target window, so
    // notify-failure's contains(needs.*.result, 'failure') never sees this —
    // without a standalone notification a broken Railway container goes
    // completely undetected ahead of the DNS flip.
    expect(deployWebRailwayJob).toContain('id: railway-smoke');
    const warnStep = stepNamed(deployWebRailwayJob, 'Notify Discord (Railway smoke failed, Vercel still serving)');
    expect(warnStep).toContain("needs.resolve-web-targets.outputs.web_vercel == 'true'");
    expect(warnStep).toContain("steps.railway-smoke.outcome == 'failure'");
    expect(warnStep).toContain('DISCORD_DEPLOY_WEBHOOK');
  });
});
