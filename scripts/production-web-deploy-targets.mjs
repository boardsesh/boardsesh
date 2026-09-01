#!/usr/bin/env node
/**
 * Resolves which deploy targets www is allowed to ship to on this run.
 *
 * Production traffic still comes off Vercel; the Railway web service exists
 * alongside it so the two can be run in parallel through the DNS flip and for a
 * rollback window afterwards. `WEB_DEPLOY_TARGETS` (a Production-ENVIRONMENT
 * variable) is the switch:
 *
 *   unset / ''       → vercel        (today's behaviour, unchanged)
 *   'vercel'         → vercel
 *   'railway'        → railway
 *   'vercel,railway' → both          (order and surrounding whitespace ignored)
 *   'none'           → neither       (web hold; the image is still pushed)
 *
 * Anything else — an unknown name, `none` mixed with a real target, or
 * `railway` with no `RAILWAY_WEB_SERVICE_ID` — throws. The caller turns that
 * into a failed job, which skips every downstream deploy rather than guessing.
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
  return String(raw ?? '')
    .split(',')
    .map((target) => target.trim().toLowerCase())
    .filter((target) => target.length > 0);
}

/**
 * @param {{ raw?: string, railwayWebServiceId?: string }} options
 * @returns {{ vercel: boolean, railway: boolean, targets: 'vercel'|'railway'|'vercel,railway'|'none' }}
 */
function resolveWebDeployTargets({ raw = '', railwayWebServiceId = '' } = {}) {
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
    return { vercel: false, railway: false, targets: 'none' };
  }

  const vercel = effective.includes('vercel');
  const railway = effective.includes('railway');

  // Fail closed rather than redeploy "the empty service id", which Railway
  // answers with a confusing permissions error two steps later.
  if (railway && String(railwayWebServiceId ?? '').trim() === '') {
    throw new Error(
      'WEB_DEPLOY_TARGETS names railway but RAILWAY_WEB_SERVICE_ID is empty; ' +
        'create the Railway web service and set the Production-environment variable first',
    );
  }

  const targets = [vercel ? 'vercel' : '', railway ? 'railway' : ''].filter(Boolean).join(',');
  return { vercel, railway, targets };
}

/** What to print for the raw variable, so an unset value reads as unset. */
function describeRaw(raw) {
  const trimmed = String(raw ?? '').trim();
  return trimmed === '' ? '<unset>' : trimmed;
}

function runCli() {
  const raw = process.env.WEB_DEPLOY_TARGETS ?? '';
  const resolved = resolveWebDeployTargets({
    raw,
    railwayWebServiceId: process.env.RAILWAY_WEB_SERVICE_ID ?? '',
  });

  const outputs = `web_vercel=${resolved.vercel}\nweb_railway=${resolved.railway}\nweb_targets=${resolved.targets}\n`;
  const outputPath = process.env.GITHUB_OUTPUT ?? '';
  if (outputPath) appendFileSync(outputPath, outputs, 'utf8');
  else process.stdout.write(outputs);

  console.log(`::notice::Web deploy targets: ${resolved.targets} (WEB_DEPLOY_TARGETS=${describeRaw(raw)}).`);
  if (!resolved.railway) {
    console.log(
      `::notice::Railway web redeploy not targeted (WEB_DEPLOY_TARGETS=${describeRaw(raw)}); ` +
        'the web image is still pushed to GHCR.',
    );
  }

  return resolved;
}

if (process.argv[1] === scriptPath) {
  try {
    runCli();
  } catch (error) {
    console.log(`::error::production-web-deploy-targets: ${error.message}`);
    process.exit(1);
  }
}

export { resolveWebDeployTargets };
