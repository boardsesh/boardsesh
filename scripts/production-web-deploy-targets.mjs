#!/usr/bin/env node
/**
 * Resolves which deploy targets www is allowed to ship to on this run.
 *
 * Railway is the only web deployer. `WEB_DEPLOY_TARGETS` (a
 * Production-ENVIRONMENT variable) is the switch:
 *
 *   unset / '' → railway   (the default)
 *   'railway'  → railway   (the same, written out)
 *   'none'     → no deploy (web hold; the image is still pushed)
 *
 * `vercel` is accepted and IGNORED, with a warning. That tolerance exists for
 * exactly one reason: when this scrub merged, the live value was
 * `vercel,railway`, and a resolver that threw on it would have failed
 * resolve-web-targets and skipped every web deploy until someone noticed. Since
 * the variable and the workflow are changed by different people at different
 * times, the code has to survive either order. A bare `vercel` resolves to
 * `railway` rather than to a hold: the operator's intent was "deploy www", and
 * Railway is now the only way to do that. Remove the entry and this branch goes
 * with it — see the follow-up in docs/production-deploy.md.
 *
 * Anything else — an unknown name, `none` mixed with a real target, or
 * `railway` with no `RAILWAY_WEB_SERVICE_ID` or `RAILWAY_WEB_ORIGIN` — throws.
 * The caller turns that into a failed job, which skips every downstream deploy
 * rather than guessing or silently omitting the post-deploy smoke.
 *
 * The GHCR image build is deliberately NOT gated on any of this: the image is
 * the artifact, and publishing it is free and reversible. Only the redeploys
 * are gated.
 */
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

/** The deploy targets that name a real deployer. `none` is a hold, not a target. */
const KNOWN_TARGETS = Object.freeze(['railway']);

/** Retired targets: accepted so a stale variable cannot fail the run, then dropped. */
const LEGACY_TARGETS = Object.freeze(['vercel']);

/** Unset resolves to Railway, the only deployer. */
const DEFAULT_TARGET = 'railway';

function parseRequestedTargets(raw) {
  const rawTargets = String(raw ?? '');
  if (rawTargets.trim() === '') return [];

  const targets = rawTargets.split(',').map((target) => target.trim().toLowerCase());
  if (targets.some((target) => target.length === 0)) {
    throw new Error('WEB_DEPLOY_TARGETS contains an empty target; remove leading, trailing, or repeated commas');
  }
  return targets;
}

function normalizeRailwayWebOrigin(rawOrigin) {
  const trimmed = String(rawOrigin ?? '').trim();
  if (trimmed === '') {
    throw new Error(
      'WEB_DEPLOY_TARGETS names railway but RAILWAY_WEB_ORIGIN is empty; ' +
        'set the Production-environment smoke origin before targeting Railway',
    );
  }

  let origin;
  try {
    origin = new URL(trimmed);
  } catch {
    throw new Error('RAILWAY_WEB_ORIGIN must be a valid HTTPS Railway service origin');
  }

  // This is a deployment-identity probe, not the user-facing origin. Bind it
  // to Railway's generated hostname so custom-domain DNS, redirects, or CDN
  // caches cannot make a stale deployment satisfy the post-deploy smoke.
  const directRailwayHost =
    origin.hostname.endsWith('.up.railway.app') && origin.hostname.length > '.up.railway.app'.length;
  if (
    origin.protocol !== 'https:' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.port !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    !directRailwayHost
  ) {
    throw new Error(
      'RAILWAY_WEB_ORIGIN must be a direct https://*.up.railway.app origin with no credentials, port, path, query, or fragment',
    );
  }

  return origin.origin;
}

/**
 * @param {{ raw?: string, railwayWebServiceId?: string, railwayWebOrigin?: string }} options
 * @returns {{ railway: boolean, targets: 'railway'|'none', railwayServiceId: string, railwayOrigin: string }}
 */
function resolveWebDeployTargets({ raw = '', railwayWebServiceId = '', railwayWebOrigin = '', warn } = {}) {
  const requested = parseRequestedTargets(raw);

  // Drop retired targets BEFORE the unknown-name check, so a stale
  // `vercel,railway` resolves instead of throwing. Warn once, naming the entry,
  // so the variable actually gets cleaned up rather than lingering forever.
  const retired = requested.filter((target) => LEGACY_TARGETS.includes(target));
  const kept = requested.filter((target) => !LEGACY_TARGETS.includes(target));
  if (retired.length > 0) {
    warn?.(
      `WEB_DEPLOY_TARGETS still names ${retired.map((target) => JSON.stringify(target)).join(', ')}; ` +
        'that target is retired and is being ignored. Remove it from the Production-environment variable.',
    );
  }

  // A variable that named ONLY retired targets still meant "deploy www", so it
  // falls through to the default rather than becoming an accidental hold.
  const effective = kept.length === 0 ? [DEFAULT_TARGET] : kept;

  const unknown = effective.filter((target) => target !== 'none' && !KNOWN_TARGETS.includes(target));
  if (unknown.length > 0) {
    throw new Error(
      `WEB_DEPLOY_TARGETS names unknown target(s) ${unknown.map((target) => JSON.stringify(target)).join(', ')}; ` +
        `expected any of ${KNOWN_TARGETS.join(', ')} or none`,
    );
  }

  if (effective.includes('none')) {
    if (effective.length > 1) {
      throw new Error(
        `WEB_DEPLOY_TARGETS mixes "none" with ${effective.filter((target) => target !== 'none').join(', ')}; ` +
          '"none" is a hold and cannot be combined with a deploy target',
      );
    }
    return {
      railway: false,
      targets: 'none',
      railwayServiceId: '',
      railwayOrigin: '',
    };
  }

  const railway = effective.includes('railway');

  // Fail closed rather than redeploy "the empty service id", which Railway
  // answers with a confusing permissions error two steps later.
  const normalizedServiceId = String(railwayWebServiceId ?? '')
    .trim()
    .toLowerCase();
  if (railway && normalizedServiceId === '') {
    throw new Error(
      'WEB_DEPLOY_TARGETS names railway but RAILWAY_WEB_SERVICE_ID is empty; ' +
        'create the Railway web service and set the Production-environment variable first',
    );
  }
  if (railway && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalizedServiceId)) {
    throw new Error('RAILWAY_WEB_SERVICE_ID must be a Railway service UUID');
  }

  // A Railway deploy without an origin cannot run the post-deploy smoke, and
  // Railway is the sole target: the workflow would otherwise report success
  // without proving the service users are about to reach.
  const normalizedOrigin = railway ? normalizeRailwayWebOrigin(railwayWebOrigin) : '';

  const targets = railway ? 'railway' : '';
  return {
    railway,
    targets,
    railwayServiceId: railway ? normalizedServiceId : '',
    railwayOrigin: normalizedOrigin,
  };
}

/** What to print for the raw variable, so an unset value reads as unset. */
function describeRaw(raw) {
  const trimmed = String(raw ?? '').trim();
  return trimmed === '' ? '<unset>' : trimmed;
}

function workflowCommandValue(rawValue) {
  return String(rawValue).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function githubOutputValue(outputName, rawValue) {
  const outputValue = String(rawValue);
  if (outputValue.includes('\r') || outputValue.includes('\n')) {
    throw new Error(`${outputName} must be a single-line GitHub output`);
  }
  return outputValue;
}

function formatGithubOutputs(resolved) {
  return (
    `web_railway=${githubOutputValue('web_railway', resolved.railway)}\n` +
    `web_targets=${githubOutputValue('web_targets', resolved.targets)}\n` +
    `web_railway_service_id=${githubOutputValue('web_railway_service_id', resolved.railwayServiceId)}\n` +
    `web_railway_origin=${githubOutputValue('web_railway_origin', resolved.railwayOrigin)}\n`
  );
}

function runCli() {
  const raw = process.env.WEB_DEPLOY_TARGETS ?? '';
  const resolved = resolveWebDeployTargets({
    raw,
    railwayWebServiceId: process.env.RAILWAY_WEB_SERVICE_ID ?? '',
    railwayWebOrigin: process.env.RAILWAY_WEB_ORIGIN ?? '',
    // A warning, not an error: a retired entry must never fail the deploy (see
    // the header). ::warning:: rather than ::notice:: so it surfaces on the run
    // summary and someone eventually clears the variable.
    warn: (message) => console.log(`::warning::${workflowCommandValue(message)}`),
  });

  const outputs = formatGithubOutputs(resolved);
  const outputPath = process.env.GITHUB_OUTPUT ?? '';
  if (outputPath) appendFileSync(outputPath, outputs, 'utf8');
  else process.stdout.write(outputs);

  console.log(
    `::notice::Web deploy targets: ${resolved.targets} ` +
      `(WEB_DEPLOY_TARGETS=${workflowCommandValue(describeRaw(raw))}).`,
  );
  if (!resolved.railway) {
    console.log(
      `::notice::Railway web redeploy not targeted ` +
        `(WEB_DEPLOY_TARGETS=${workflowCommandValue(describeRaw(raw))}); ` +
        'the web image is still pushed to GHCR.',
    );
  }

  return resolved;
}

if (process.argv[1] === scriptPath) {
  try {
    runCli();
  } catch (error) {
    console.log(`::error::production-web-deploy-targets: ${workflowCommandValue(error.message)}`);
    process.exit(1);
  }
}

export { formatGithubOutputs, normalizeRailwayWebOrigin, resolveWebDeployTargets, workflowCommandValue };
