#!/usr/bin/env node
/**
 * Resolves which deploy targets www is allowed to ship to on this run.
 *
 * Production traffic still comes off Vercel; the Railway web service exists
 * alongside it so the two can be run in parallel before the DNS flip. After
 * cut-over, Railway is the only active deployer and Vercel's last-good release
 * stays frozen for the rollback window. `WEB_DEPLOY_TARGETS` (a
 * Production-ENVIRONMENT variable) is the switch:
 *
 *   unset / ''       → vercel        (today's behaviour, unchanged)
 *   'vercel'         → vercel
 *   'railway'        → railway
 *   'vercel,railway' → both          (order and surrounding whitespace ignored)
 *   'none'           → neither       (web hold; the image is still pushed)
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
const KNOWN_TARGETS = Object.freeze(['vercel', 'railway']);

/** Unset resolves to Vercel so merging the dual-deploy wiring changes nothing. */
const DEFAULT_TARGET = 'vercel';

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
 * @returns {{ vercel: boolean, railway: boolean, targets: 'vercel'|'railway'|'vercel,railway'|'none', railwayServiceId: string, railwayOrigin: string }}
 */
function resolveWebDeployTargets({ raw = '', railwayWebServiceId = '', railwayWebOrigin = '' } = {}) {
  const requested = parseRequestedTargets(raw);
  const effective = requested.length === 0 ? [DEFAULT_TARGET] : requested;

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
      vercel: false,
      railway: false,
      targets: 'none',
      railwayServiceId: '',
      railwayOrigin: '',
    };
  }

  const vercel = effective.includes('vercel');
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

  // A Railway deploy without an origin cannot run the post-deploy smoke. That
  // is especially unsafe once Railway is the sole target: the workflow would
  // otherwise report success without proving the service users are about to
  // reach. Require the origin before either dual-running or cutting over.
  const normalizedOrigin = railway ? normalizeRailwayWebOrigin(railwayWebOrigin) : '';

  const targets = [vercel ? 'vercel' : '', railway ? 'railway' : ''].filter(Boolean).join(',');
  return {
    vercel,
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

function formatGithubOutputs(resolved) {
  return (
    `web_vercel=${resolved.vercel}\n` +
    `web_railway=${resolved.railway}\n` +
    `web_targets=${resolved.targets}\n` +
    `web_railway_service_id=${resolved.railwayServiceId}\n` +
    `web_railway_origin=${resolved.railwayOrigin}\n`
  );
}

function runCli() {
  const raw = process.env.WEB_DEPLOY_TARGETS ?? '';
  const resolved = resolveWebDeployTargets({
    raw,
    railwayWebServiceId: process.env.RAILWAY_WEB_SERVICE_ID ?? '',
    railwayWebOrigin: process.env.RAILWAY_WEB_ORIGIN ?? '',
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
