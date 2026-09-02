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

function runBlock(stepSource: string): string {
  const lines = stepSource.split('\n');
  const runIndex = lines.findIndex((line) => line.trim() === 'run: |');
  if (runIndex < 0) throw new Error('step has no multiline run block');
  return lines.slice(runIndex + 1).join('\n');
}

describe('production-deploy web deploy targets', () => {
  const resolverJob = withoutComments(mappingEntry(workflowSource, 'resolve-web-targets', 2));
  const buildWebJob = withoutComments(mappingEntry(workflowSource, 'build-web', 2));
  const migrateJob = withoutComments(mappingEntry(workflowSource, 'migrate', 2));
  const deployWebRailwayJob = withoutComments(mappingEntry(workflowSource, 'deploy-web-railway', 2));
  const deployBackendJob = withoutComments(mappingEntry(workflowSource, 'deploy-production-backend', 2));
  const buildBackendJob = withoutComments(mappingEntry(workflowSource, 'build-backend', 2));

  it('never reads WEB_DEPLOY_TARGETS from a job-level if', () => {
    // The whole reason resolve-web-targets is a job. A job-level `if:` is
    // evaluated before the Production environment is attached, so `vars.` there
    // sees repository variables only — an environment-scoped WEB_DEPLOY_TARGETS
    // would silently read as empty, so an operator's deliberate `none` hold
    // would read as unset and the run would deploy anyway.
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
    for (const output of ['web_railway', 'web_targets', 'web_railway_service_id', 'web_railway_origin']) {
      expect(resolverJob).toContain(`${output}: \${{ steps.resolve.outputs.${output} }}`);
    }
  });

  it('publishes validated Railway identity once and never rereads raw web variables downstream', () => {
    const uncommentedWorkflow = withoutComments(workflowSource);
    expect(uncommentedWorkflow.match(/vars\.RAILWAY_WEB_SERVICE_ID/g) ?? []).toHaveLength(1);
    expect(uncommentedWorkflow.match(/vars\.RAILWAY_WEB_ORIGIN/g) ?? []).toHaveLength(1);
    expect(deployWebRailwayJob).toContain(
      'service-id: ${{ needs.resolve-web-targets.outputs.web_railway_service_id }}',
    );
    expect(deployWebRailwayJob).toContain(
      'RAILWAY_WEB_ORIGIN: ${{ needs.resolve-web-targets.outputs.web_railway_origin }}',
    );
  });

  it('keeps no Vercel deployer, probe or credential', () => {
    // The scrub, pinned. `check-rollback` read Vercel's Instant Rollback state
    // and `deploy-web` ran `vercel deploy --prebuilt`; both are gone, and so is
    // the second `next build` that `vercel build --prod` cost build-web.
    // Re-adding any of it would restore a 3m46s duplicate build and a
    // credential this workflow no longer needs.
    const uncommented = withoutComments(workflowSource);
    expect(uncommented).not.toContain('check-rollback');
    expect(uncommented).not.toContain('deploy-web:');
    expect(uncommented).not.toMatch(/\bvercel\b/i);
    for (const secret of ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID']) {
      expect(uncommented, secret).not.toContain(secret);
    }
  });

  it('leaves the migrate gate exactly as it was', () => {
    // The image build lives inside build-web rather than in a sibling job
    // precisely so this gate keeps meaning what it meant. A parallel PR (#4849)
    // owns this job; if that lands first, reconcile deliberately.
    expect(migrateJob).toContain('needs: [detect-changes, build-web, build-backend, sync-static-assets]');
    expect(migrateJob).toContain("!(needs.build-web.result == 'skipped' && needs.build-backend.result == 'skipped')");
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
      'BOARDSESH_BUILD_RELEASE=${{ github.sha }}',
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
      .filter((key) => key.startsWith('NEXT_PUBLIC_') || key === 'SENTRY_RELEASE' || key === 'BOARDSESH_BUILD_RELEASE')
      .filter((key) => !new RegExp(`^ARG ${key}$`, 'm').test(builderStage));

    expect(undeclared, `build-args with no ARG in ${DOCKERFILE_PATH}'s builder stage`).toEqual([]);
  });

  it('caches the image build to the registry, never to the Actions cache', () => {
    // `type=gha` cannot work for these images. The repo cache measured 36.45 GB
    // across 227 entries on 2026-09-02 against a 10 GB ceiling, so eviction is
    // continuous: four distinct ~843 MB dependency-layer blobs were written in
    // 19 hours, i.e. the scope missed on essentially every build. Falling back
    // to it would ALSO re-evict the mobile gradle caches, which is what the
    // original no-`cache-to` rule was protecting.
    //
    // The ref must stay a tag on the same image repository: a cached layer that
    // is also an image layer is then already present under its own digest, so
    // the export writes a manifest instead of re-uploading ~843 MB.
    expect(buildWebJob).not.toContain('type=gha');
    expect(buildBackendJob).not.toContain('type=gha');
    expect(buildWebJob).toContain(
      'cache-from: type=registry,ref=${{ env.REGISTRY }}/${{ github.repository_owner }}/${{ env.WEB_IMAGE_NAME }}:buildcache-main',
    );
    // mode=max is load-bearing: Dockerfile.web is multi-stage and every
    // expensive step lives in a stage the final image does not keep.
    expect(buildWebJob).toContain('mode=max');
    // The GHCR-specific pair; neither works without the other.
    expect(buildWebJob).toContain('image-manifest=true');
    expect(buildWebJob).toContain('oci-mediatypes=true');
    // A cache-export hiccup must not fail a shipped release.
    expect(buildWebJob).toContain('ignore-error=true');
    // Double compression: the image stays gzip for Railway, so a zstd cache
    // would compress every layer twice.
    expect(buildWebJob).not.toContain('compression=zstd');
  });

  it('gates the Railway web deploy behind every release gate', () => {
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
    expect(deployWebRailwayJob).toContain(
      'service-id: ${{ needs.resolve-web-targets.outputs.web_railway_service_id }}',
    );
    expect(deployWebRailwayJob).toContain('railway-token: ${{ secrets.RAILWAY_TOKEN }}');
    expect(deployWebRailwayJob).toContain('service-label: web');
    expect(deployWebRailwayJob).toContain('expected-image: ${{ needs.build-web.outputs.image }}:production');
  });

  it('binds smoke to the exact release and restores a failed Railway-only deployment', () => {
    const railwaySmokeStep = stepNamed(deployWebRailwayJob, 'Post-deploy smoke against the Railway web origin');
    expect(deployWebRailwayJob).toContain('run: node scripts/production-smoke.ts --base "$RAILWAY_WEB_ORIGIN"');
    expect(railwaySmokeStep).toContain('continue-on-error: true');
    expect(railwaySmokeStep).toContain("steps.railway-redeploy.outcome == 'success'");
    expect(deployWebRailwayJob).toContain(
      'SMOKE_EXPECTED_DEPLOYMENT_ID: ${{ steps.railway-redeploy.outputs.deployment_id }}',
    );
    expect(deployWebRailwayJob).toContain('SMOKE_EXPECTED_RELEASE: ${{ github.sha }}');
    expect(deployWebRailwayJob).toContain('uses: ./.github/actions/railway-rollback');
    expect(deployWebRailwayJob).toContain(
      'target-deployment-id: ${{ steps.railway-redeploy.outputs.previous_deployment_id }}',
    );
    expect(deployWebRailwayJob).toContain(
      'expected-current-deployment-id: ${{ steps.railway-redeploy.outputs.deployment_id }}',
    );
    const railwayRecoveryFailureStep = stepNamed(deployWebRailwayJob, 'Fail after Railway web smoke recovery');
    expect(railwayRecoveryFailureStep).toContain('ROLLBACK_OUTCOME: ${{ steps.railway-rollback.outcome }}');
    expect(railwayRecoveryFailureStep).toContain('if [ "$ROLLBACK_OUTCOME" = "success" ]');
    expect(runBlock(railwayRecoveryFailureStep)).not.toContain('${{');
    expect(railwayRecoveryFailureStep).toContain('verified automatic rollback restored');
    expect(railwayRecoveryFailureStep).toContain('automatic recovery was not verified');
    expect(railwayRecoveryFailureStep).toContain('exit 1');
    expect(deployWebRailwayJob).toContain('Verify Railway web functionality after rollback');
  });

  it('keeps a single Railway promote path', () => {
    // A second inline copy is how the two services drift: one gets a poll fix,
    // the other keeps the bug.
    expect(deployBackendJob).toContain('uses: ./.github/actions/railway-redeploy');
    expect(deployBackendJob).not.toMatch(/^\s*railway\s+redeploy\b/m);
    expect(withoutComments(workflowSource)).not.toMatch(/^\s*railway\s+redeploy\b/m);
  });

  it('binds backend redeploy and smoke recovery to the same exact-image actions', () => {
    const backendSmokeStep = stepNamed(deployBackendJob, 'Verify the live API and board renderer');
    expect(backendSmokeStep).toContain("steps.railway-redeploy.outcome == 'success'");
    expect(deployBackendJob).toContain('expected-image: ${{ needs.build-backend.outputs.image }}:production');
    expect(deployBackendJob).toContain(
      'SMOKE_EXPECTED_DEPLOYMENT_ID: ${{ steps.railway-redeploy.outputs.deployment_id }}',
    );
    expect(deployBackendJob).toContain('SMOKE_EXPECTED_RELEASE: ${{ github.sha }}');
    expect(deployBackendJob).toContain('uses: ./.github/actions/railway-rollback');
    expect(deployBackendJob).toContain(
      'target-deployment-id: ${{ steps.railway-redeploy.outputs.previous_deployment_id }}',
    );
    expect(deployBackendJob).toContain(
      'expected-current-deployment-id: ${{ steps.railway-redeploy.outputs.deployment_id }}',
    );
    expect(deployBackendJob).toContain('Verify backend functionality after rollback');
    expect(deployBackendJob).toContain("steps.backend-smoke.outcome == 'failure'");
    const backendRecoveryFailureStep = stepNamed(deployBackendJob, 'Fail after backend smoke recovery');
    expect(backendRecoveryFailureStep).toContain('ROLLBACK_OUTCOME: ${{ steps.backend-rollback.outcome }}');
    expect(backendRecoveryFailureStep).toContain('if [ "$ROLLBACK_OUTCOME" = "success" ]');
    expect(runBlock(backendRecoveryFailureStep)).not.toContain('${{');
    expect(backendRecoveryFailureStep).toContain('verified automatic rollback restored');
    expect(backendRecoveryFailureStep).toContain('automatic recovery was not verified');
    expect(backendRecoveryFailureStep).toContain('exit 1');
  });

  it('pins every external action in the credentialed production workflow to a full commit', () => {
    const externalUses = [...workflowSource.matchAll(/^\s*(?:- )?uses:\s+([^\s#]+)/gm)]
      .map(([, action]) => action)
      .filter((action) => !action.startsWith('./'));
    expect(externalUses.length).toBeGreaterThan(10);
    for (const action of externalUses) {
      expect(action, action).toMatch(/@[0-9a-f]{40}$/);
    }
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
    expect(successJob).toContain('deployed (Railway)');
  });

  it('fails the web image build when the PostHog key is empty', () => {
    // The GHCR image is UNGATED by WEB_DEPLOY_TARGETS (always builds), so a
    // missing key here would silently ship a Railway image with client
    // analytics disabled, and nothing downstream catches it.
    const guardStep = stepNamed(buildWebJob, 'Require a PostHog key for the web image build');
    expect(guardStep).toContain('NEXT_PUBLIC_POSTHOG_KEY: ${{ vars.NEXT_PUBLIC_POSTHOG_KEY }}');
    expect(guardStep).toContain('vars.NEXT_PUBLIC_POSTHOG_KEY is unset');
    expect(guardStep).toContain('exit 1');
    // Must run before the image build actually consumes the var.
    expect(buildWebJob.indexOf('Require a PostHog key for the web image build')).toBeLessThan(
      buildWebJob.indexOf('name: Build and push web image'),
    );
  });

  it('rolls the web service back on ANY failed smoke, with no shadow window left', () => {
    // While Vercel served www a Railway smoke failure was a shadow signal: the
    // rollback was suppressed and two steps posted warnings instead. Railway is
    // the live origin now, so a failed smoke must restore the captured
    // last-known-good deployment unconditionally. Re-introducing a
    // `web_vercel`-shaped condition here would silently leave a broken
    // container serving www.
    expect(deployWebRailwayJob).toContain('id: railway-smoke');

    const rollbackStep = stepNamed(deployWebRailwayJob, 'Restore the previous Railway web deployment');
    expect(rollbackStep).toContain("if: steps.railway-smoke.outcome == 'failure'");
    expect(rollbackStep).not.toContain('web_vercel');

    // The two shadow-window steps are gone, not merely disabled.
    expect(deployWebRailwayJob).not.toContain('Report a shadow Railway smoke failure');
    expect(deployWebRailwayJob).not.toContain('Vercel still serving');

    // Nothing in the job may condition on a resolved Vercel target any more.
    expect(deployWebRailwayJob).not.toContain('web_vercel');
  });
});
