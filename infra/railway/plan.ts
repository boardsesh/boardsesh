/// <reference types="node" />

// Pure planning logic for the Railway apply tool: diff desired-vs-live and decide
// what may be converged automatically and what may only be reported. No I/O, no
// globals — everything here is deterministic and unit-tested in
// scripts/railway-apply.test.ts. The I/O (fetching live state, applying changes)
// lives in scripts/railway-apply.ts.
//
// Four safety rules are encoded here rather than in the apply layer, so they are
// testable without a live project and cannot be bypassed by a caller:
//
//   1. Never delete. A live service, variable or domain absent from config is
//      reported and left alone, the way the Cloudflare tool preserves foreign
//      rules verbatim.
//   2. Never overwrite an unmanaged value that is already set. Only `absent` and
//      `placeholder` are drift this tool will fix for a variable it holds no
//      declared value for. A variable declared WITH a value in config.ts is
//      non-secret by construction and is owned — that one is converged.
//   3. Never surface an unmanaged value. A variable with no declared value is reduced
//      to a three-state classification before it reaches a PlannedChange, so no
//      code path can print a DSN or a token. The live value of an owned variable
//      is not printed either — only the declared one, which is already in the repo.
//   4. Never roll a new container image without being asked. The image change is
//      gated on an explicit opt-in flag, the same way the Cloudflare tool gates the
//      zone-wide SSL change behind --allow-zone-ssl.

import {
  CLICKHOUSE_SERVICE_NAME,
  OTA_SERVICE_NAME,
  PLACEHOLDER_PATTERN,
  type DeploySettings,
  type RailwayDesiredState,
  type ServiceDesired,
  type TableRetentionDesired,
} from './config';

/** A service as Railway reports it. */
export interface LiveService {
  id: string;
  name: string;
}

/** A custom domain as Railway reports it. */
export interface LiveCustomDomain {
  domain: string;
  targetPort: number | null;
}

/**
 * One service's live instance configuration, as read from `serviceInstance`.
 *
 * Deliberately omits `builder` and `buildEnvironment`: Railway sets them on every
 * service, including image-sourced ones where they are vestigial, so diffing them
 * would report permanent false drift.
 */
export interface LiveServiceInstance {
  image: string | null;
  /**
   * The image of the uniquely identified active SUCCESS deployment, per its
   * `meta`. Null means no unique serving image could be established.
   *
   * Distinct from `image`, which is what the service is *configured* to run.
   * `serviceInstanceUpdate` writes configuration only, so a run that died between
   * writing the image and rolling the deployment leaves these two disagreeing —
   * and a drift check that only read the configured value would call that in sync
   * forever, while the next unrelated deploy shipped the never-verified image.
   */
  runningImage: string | null;
  healthcheckPath: string | null;
  healthcheckTimeout: number | null;
  restartPolicyType: string | null;
  restartPolicyMaxRetries: number | null;
  drainingSeconds: number | null;
  region: string | null;
  /**
   * Replica count. Railway reports this both as a scalar and inside the opaque
   * `multiRegionConfig` JSON, and the scalar can read as in-sync while the real
   * value sits in the JSON — which is one reason replicas are report-only.
   */
  numReplicas: number | null;
  customDomains: LiveCustomDomain[];
  /** Mount paths of every volume attached to this service. */
  volumeMountPaths: string[];
}

/**
 * Live state for one environment.
 *
 * `variables` maps service name -> variable name -> raw value. The raw values are
 * needed to classify placeholder-vs-set and to compare an owned value, and they
 * never leave this module: `classifyVar` and `diffServiceVars` are the only things
 * that read them, and neither puts one in a PlannedChange.
 */
export interface LiveState {
  services: LiveService[];
  variables: Record<string, Record<string, string>>;
  /** Absent when skipped; null when the selected environment has no instance. */
  instances: Record<string, LiveServiceInstance | null>;
  /**
   * Live TTL expressions keyed by table name, as read from ClickHouse's
   * system.tables. `null` means the retention check did not run — no ClickHouse
   * DSN was available to the tool — which is a skip, not a failure.
   */
  clickhouseTtl: Record<string, string> | null;
  /**
   * ClickHouse volume utilisation. `null` means the reading was unavailable,
   * which is a skip rather than "there is plenty of room".
   */
  clickhouseVolume: { usedMb: number; capacityMb: number } | null;
}

export type VarState = 'set' | 'absent' | 'placeholder';

export type PlannedResource =
  | 'service'
  | 'service-instance'
  | 'service-image'
  | 'deploy-setting'
  | 'domain'
  | 'env-var'
  | 'scale'
  | 'volume'
  | 'volume-usage'
  | 'clickhouse-ttl';

export interface PlannedChange {
  resource: PlannedResource;
  /** One-line human-readable summary of what would change. Never contains a secret value. */
  summary: string;
  /** Optional extra context printed under the summary. */
  detail?: string;
  /** Present for env-var changes so the apply layer can select the right service/variable. */
  target?: { serviceName: string; varName: string };
  /** Present for service-scoped changes so the apply layer knows what to mutate. */
  service?: string;
  /** For deploy-setting changes: the field and the value to write. */
  deployField?: { name: keyof DeploySettings; value: string | number };
  /** For service-image changes: the image to move to. */
  image?: string;
  /**
   * true = a change that is NOT auto-applied. Creating a service, anything that
   * would remove live configuration, and anything whose blast radius needs a human
   * are reported rather than applied.
   */
  blocked?: boolean;
}

export interface PlanOptions {
  /**
   * Keys (`"<service>:<VAR>"`) whose value the apply layer actually holds, having
   * found it in its own environment as `RAILWAY_VAR_<VAR>`.
   *
   * This is what separates "drift we can fix" from "drift we can only report" for
   * SECRET variables. Keeping it a plain set of keys — never the values — is what
   * lets the whole plan layer stay pure and keeps secrets out of every
   * PlannedChange. Variables declared with a value in config.ts do not need this:
   * their value is already in the repo.
   */
  suppliedVars: ReadonlySet<string>;
  /**
   * Whether the caller opted in to changing the container image.
   *
   * Rolling a new image on the service every production binary talks to is a
   * categorically larger act than correcting a healthcheck path, so it needs to be
   * asked for. The nightly drift check never passes this; the apply workflow does.
   */
  allowImageChange?: boolean;
  /**
   * The `eoas` CLI version this repo publishes with, from EOAS_PACKAGE_SPEC.
   *
   * A CLI that trails the server can 404 on app-scoped routes, so an image ahead
   * of this version is a blocked plan entry. (Since 3.2.0 the CLI may not lead
   * either; eoas-version-parity.test.ts requires the two to be equal.)
   */
  eoasVersion?: string;
}

/** The key shape used by PlanOptions.suppliedVars. */
export function varKey(serviceName: string, varName: string): string {
  return `${serviceName}:${varName}`;
}

/**
 * Reduce a raw variable to the only three states this tool distinguishes.
 *
 * A placeholder is treated as absent-with-a-hint rather than as set: it passes a
 * naive "is it defined?" check and then fails at boot, which is the confusing
 * failure this classification exists to prevent.
 */
export function classifyVar(rawValue: string | undefined): VarState {
  if (rawValue === undefined) return 'absent';
  const trimmed = rawValue.trim();
  if (trimmed === '') return 'absent';
  if (PLACEHOLDER_PATTERN.test(trimmed)) return 'placeholder';
  return 'set';
}

/** Find a live service by name. Names are Railway-unique within an environment. */
export function findService(live: LiveState, name: string): LiveService | null {
  return live.services.find((service) => service.name === name) ?? null;
}

/** Services this tool asserts anything at all about. */
function isAsserted(desired: ServiceDesired): boolean {
  return desired.management !== 'inventory';
}

/**
 * Compare two dotted version strings, prerelease-aware.
 *
 * Upstream spells prereleases two ways — `3.0.0-beta.3` and `3.1.2-beta2` — and
 * both are valid semver, so the comparison cannot assume one form. Returns a
 * negative number when `left` sorts first, positive when `right` does, 0 when equal.
 */
export function compareVersions(left: string, right: string): number {
  const split = (version: string) => {
    const bare = version.replace(/^v/, '');
    // NOT `split('-', 2)`: JavaScript's limit argument truncates rather than
    // keeping the remainder, so `3.1.0-rc-2` would parse its prerelease as `rc`
    // and compare EQUAL to `3.1.0-rc-1` — silently disarming the gate that stops
    // the server outranking the CLI.
    const dash = bare.indexOf('-');
    const core = dash === -1 ? bare : bare.slice(0, dash);
    const prerelease = dash === -1 ? undefined : bare.slice(dash + 1);
    // Callers supply versions from the validated image/release tags or CLI pin;
    // this comparator's numeric normalization is not an input-validation gate.
    const numbers = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
    return { numbers, prerelease };
  };

  const a = split(left);
  const b = split(right);

  for (let index = 0; index < 3; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }

  // A release outranks any prerelease of the same core version.
  if (a.prerelease === undefined && b.prerelease === undefined) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;

  const aParts = a.prerelease.split('.');
  const bParts = b.prerelease.split('.');
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const aPart = aParts[index];
    const bPart = bParts[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNumeric && bNumeric) {
      const difference = Number.parseInt(aPart, 10) - Number.parseInt(bPart, 10);
      if (difference !== 0) return difference;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (aPart !== bPart) {
      // A deliberate departure from strict semver, for the tags upstream actually
      // publishes. Semver compares alphanumeric identifiers in ASCII order, which
      // ranks `beta10` BELOW `beta2` — so on the day xprem ships a tenth beta, a
      // spec-pure comparison would propose the ninth as the newest. Upstream writes
      // these undotted (`v3.2.0-beta1`), plainly meaning a counter, so a trailing
      // number is compared as one. Dotted forms (`v3.0.0-beta.3`) already split into
      // their own identifiers and take the numeric branch above.
      const aSplit = /^(.*?)(\d*)$/.exec(aPart);
      const bSplit = /^(.*?)(\d*)$/.exec(bPart);
      if (aSplit && bSplit && aSplit[1] === bSplit[1] && aSplit[2] !== '' && bSplit[2] !== '') {
        return Number.parseInt(aSplit[2], 10) - Number.parseInt(bSplit[2], 10);
      }
      return aPart < bPart ? -1 : 1;
    }
  }
  return 0;
}

/** Pull the `vX.Y.Z` tag off an image reference. */
export function imageVersion(image: string): string | null {
  const match = /:v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/.exec(image);
  return match ? match[1] : null;
}

/**
 * Diff one declared service's existence.
 *
 * A service that is missing is an error in the config or a renamed service —
 * either way a human question, so it is blocked rather than created.
 */
export function diffService(desired: ServiceDesired, live: LiveState): PlannedChange | null {
  if (!isAsserted(desired)) return null;
  if (findService(live, desired.name)) return null;

  if (desired.image || desired.volume) {
    return {
      resource: 'service',
      summary: `Service "${desired.name}" does not exist`,
      detail:
        `Create it in Railway with image ${desired.image}` +
        (desired.volume ? ` and a persistent volume mounted at ${desired.volume.mountPath}` : '') +
        `, in the same project so private networking reaches it.\n` +
        `Not created automatically: a stateful service without a volume looks healthy and ` +
        `loses every row on redeploy.`,
      blocked: true,
    };
  }

  return {
    resource: 'service',
    summary: `Service "${desired.name}" does not exist`,
    detail:
      `Expected an existing service to assert against. Either it was renamed, or this tool is ` +
      `pointed at the wrong Railway project/environment.`,
    blocked: true,
  };
}

/**
 * Diff the container image.
 *
 * Two independent gates stand between a declared version and a rolled container:
 * the caller must have opted in, and the OTA server must not be about to outrank
 * the CLI this repo publishes with. Unrelated services have independent versions.
 */
export function diffServiceImage(desired: ServiceDesired, live: LiveState, options: PlanOptions): PlannedChange | null {
  if (desired.management !== 'managed' || !desired.image) return null;
  const instance = live.instances[desired.name];
  if (!instance) return null;
  if (instance.runningImage === null) {
    return {
      resource: 'service-image',
      summary: `${desired.name}: could not identify a unique serving deployment image`,
      service: desired.name,
      detail:
        `The active deployment list has no unique SUCCESS entry with image metadata. ` +
        `A missing or ambiguous serving deployment cannot prove convergence or establish a safe image baseline. ` +
        `Verify the serving deployment in Railway before retrying; this service will not be changed.`,
      blocked: true,
    };
  }
  // Is what the service is configured for what is actually running? A mismatch
  // means an earlier run (or a dashboard edit) wrote an image and never got a
  // deployment to carry it. Checked before the declared image is even looked at:
  // deploying a third image over such a split, and then rolling back after a
  // failed probe, would restore the serving container AND the configured image —
  // leaving the split in place and the next deploy poised to ship an image nobody
  // probed. Reported rather than applied: re-deploying somebody else's
  // half-finished change unattended is worse than saying so.
  if (instance.image !== instance.runningImage) {
    const configuredImage = instance.image ?? '(none)';
    return {
      resource: 'service-image',
      summary: `${desired.name}: configured for ${configuredImage} but running ${instance.runningImage}`,
      service: desired.name,
      detail:
        `The service's configured image differs from the one the live container was built ` +
        `from, so something wrote the image without a deployment to carry it.\n` +
        `The next deploy of this service for ANY reason will ship ${configuredImage} without ` +
        `passing through this tool's probe or rollback.\n` +
        (configuredImage === desired.image
          ? `Fix: redeploy the service in Railway, having checked ${desired.image} is what you want.`
          : `This repo declares ${desired.image}. Fix: in Railway, either redeploy the configured ` +
            `image (having checked it is what you want) or set the image back to ` +
            `${instance.runningImage}, then re-run so this tool rolls ${desired.image} from a ` +
            `consistent baseline.`),
      blocked: true,
    };
  }
  if (instance.image === desired.image) return null;

  const declaredVersion = imageVersion(desired.image);
  const cliVersion = desired.name === OTA_SERVICE_NAME ? options.eoasVersion : undefined;
  const summary = `${desired.name}: image is ${instance.image ?? '(none)'}, declared ${desired.image}`;

  // A tag this tool cannot parse — `:latest`, `:v3.2`, a bare digest — must BLOCK,
  // not wave the change through. Treating "cannot tell" as "must be fine" would
  // disable the CLI-must-not-trail guard for exactly the tags that skip it.
  if (cliVersion !== undefined && declaredVersion === null) {
    return {
      resource: 'service-image',
      summary,
      service: desired.name,
      image: desired.image,
      detail:
        `Refusing: cannot read a version out of "${desired.image}", so the rule that the server ` +
        `must not outrank the eoas CLI (${cliVersion}) cannot be checked.\n` +
        `Declare an exact \`:v<major>.<minor>.<patch>\` tag.`,
      blocked: true,
    };
  }

  const cliWouldTrail =
    declaredVersion !== null && cliVersion !== undefined && compareVersions(declaredVersion, cliVersion) > 0;

  if (cliWouldTrail) {
    return {
      resource: 'service-image',
      summary,
      service: desired.name,
      image: desired.image,
      detail:
        `Refusing: this would move the server to ${declaredVersion} while the repo publishes with ` +
        `eoas ${cliVersion}.\n` +
        `The CLI may lead the server but must never trail it — a CLI that trails can 404 on ` +
        `app-scoped routes (docs/mobile-ota-updates.md).\n` +
        `Fix: bump EOAS_PACKAGE_SPEC in scripts/lib/eoas.ts first, in the same PR.`,
      blocked: true,
    };
  }

  if (!options.allowImageChange) {
    return {
      resource: 'service-image',
      summary,
      service: desired.name,
      image: desired.image,
      detail:
        `Rolling a new image on the server every production binary talks to needs an explicit ` +
        `opt-in.\n` +
        `Re-run with --apply --allow-image-change to converge it.`,
      blocked: true,
    };
  }

  return {
    resource: 'service-image',
    summary,
    service: desired.name,
    image: desired.image,
    detail:
      `--apply will set the image, roll a new deployment, wait for it to succeed, probe the ` +
      `server, and roll back automatically if it does not answer.`,
  };
}

const DEPLOY_FIELD_LABELS: Record<keyof DeploySettings, string> = {
  healthcheckPath: 'healthcheck path',
  healthcheckTimeout: 'healthcheck timeout',
  restartPolicyType: 'restart policy',
  restartPolicyMaxRetries: 'restart retries',
  drainingSeconds: 'draining seconds',
};

/**
 * Diff the deploy settings, one change per field.
 *
 * One change per field rather than one per service, so the plan output names
 * exactly what moves instead of saying "settings differ".
 */
export function diffDeploySettings(desired: ServiceDesired, live: LiveState): PlannedChange[] {
  if (desired.management !== 'managed' || !desired.deploy) return [];
  const instance = live.instances[desired.name];
  if (!instance) return [];

  const changes: PlannedChange[] = [];
  const fields = Object.keys(desired.deploy) as (keyof DeploySettings)[];

  for (const field of fields) {
    const declared = desired.deploy[field];
    // Under ALWAYS Railway restarts without limit and the retry count means
    // nothing, and what Railway stores for it then is not documented. Comparing it
    // would report drift nobody can act on, and writing it would be a guess, so it
    // is neither compared nor written. It still counts under ON_FAILURE.
    if (field === 'restartPolicyMaxRetries' && desired.deploy.restartPolicyType === 'ALWAYS') continue;
    if (declared === undefined) continue;
    const liveValue = instance[field];
    if (liveValue === declared) continue;

    changes.push({
      resource: 'deploy-setting',
      summary: `${desired.name}: ${DEPLOY_FIELD_LABELS[field]} is ${liveValue ?? '(unset)'}, declared ${declared}`,
      service: desired.name,
      deployField: { name: field, value: declared },
      detail:
        field === 'drainingSeconds'
          ? 'Railway defaults to 0s, severing in-flight requests on every redeploy.'
          : field === 'healthcheckPath'
            ? 'Without a healthcheck Railway cannot tell a wedged boot from a healthy one.'
            : undefined,
    });
  }

  return changes;
}

/**
 * Diff the custom domains.
 *
 * Everything here is report-only, deliberately. A Railway custom domain is only
 * half of the change — the other half is the DNS record, which lives in
 * infra/cloudflare/config.ts — and creating one side alone leaves a domain that
 * never verifies. Retargeting the port of the domain every production binary talks
 * to is likewise not an unattended action. Extra live domains are never removed.
 */
export function diffCustomDomains(desired: ServiceDesired, live: LiveState): PlannedChange[] {
  if (desired.management !== 'managed' || !desired.domains) return [];
  const instance = live.instances[desired.name];
  if (!instance) return [];

  const changes: PlannedChange[] = [];

  for (const declared of desired.domains) {
    const liveDomain = instance.customDomains.find((candidate) => candidate.domain === declared.domain);
    if (!liveDomain) {
      changes.push({
        resource: 'domain',
        summary: `${desired.name}: custom domain ${declared.domain} is missing`,
        service: desired.name,
        detail:
          `Add it in Railway targeting port ${declared.targetPort}, and make sure the matching DNS ` +
          `record exists (infra/cloudflare/config.ts).\n` +
          `Not created automatically: a Railway domain without its DNS record never verifies.`,
        blocked: true,
      });
      continue;
    }
    if (liveDomain.targetPort !== declared.targetPort) {
      changes.push({
        resource: 'domain',
        summary: `${desired.name}: ${declared.domain} targets port ${liveDomain.targetPort ?? '(unset)'}, declared ${declared.targetPort}`,
        service: desired.name,
        detail: 'Retargeting the port of a live domain is a human action; every binary talks to it.',
        blocked: true,
      });
    }
  }

  const declaredNames = new Set(desired.domains.map((domain) => domain.domain));
  for (const liveDomain of instance.customDomains) {
    if (declaredNames.has(liveDomain.domain)) continue;
    changes.push({
      resource: 'domain',
      summary: `${desired.name}: custom domain ${liveDomain.domain} is live but not declared`,
      service: desired.name,
      detail: 'Left alone. Add it to config.ts, or remove it in Railway if it is genuinely stale.',
      blocked: true,
    });
  }

  return changes;
}

/**
 * Diff the volume mount.
 *
 * Always blocked. Attaching a volume is a create, and Railway's public API exposes
 * no way to resize one either — `sizeMB` appears on no input type in the schema —
 * so reporting is not conservatism here, it is the whole of what is possible.
 */
export function diffVolumeMount(desired: ServiceDesired, live: LiveState): PlannedChange | null {
  if (!isAsserted(desired) || !desired.volume) return null;
  const instance = live.instances[desired.name];
  if (!instance) return null;
  if (instance.volumeMountPaths.includes(desired.volume.mountPath)) return null;

  return {
    resource: 'volume',
    summary: `${desired.name}: no volume mounted at ${desired.volume.mountPath}`,
    service: desired.name,
    detail:
      `Mounted: ${instance.volumeMountPaths.join(', ') || '(none)'}\n` +
      `A service that lost its volume looks perfectly healthy and loses its data on the next ` +
      `redeploy. Attach one in Railway.`,
    blocked: true,
  };
}

/**
 * Diff replica count and region.
 *
 * Always blocked. Both are capacity and data-locality decisions with a cost
 * attached, moving a region relocates a running service, and Railway's replica
 * state lives in an opaque `multiRegionConfig` JSON that a scalar write does not
 * reliably move. Worth noticing; not worth a script changing.
 */
export function diffScale(desired: ServiceDesired, live: LiveState): PlannedChange[] {
  if (desired.management !== 'managed' || !desired.expectedScale) return [];
  const instance = live.instances[desired.name];
  if (!instance) return [];

  const changes: PlannedChange[] = [];

  if (instance.numReplicas !== null && instance.numReplicas !== desired.expectedScale.numReplicas) {
    changes.push({
      resource: 'scale',
      summary: `${desired.name}: ${instance.numReplicas} replicas, expected ${desired.expectedScale.numReplicas}`,
      service: desired.name,
      detail: 'Reported, never applied. Replica count is a capacity decision with a bill attached.',
      blocked: true,
    });
  }

  if (instance.region !== null && instance.region !== desired.expectedScale.region) {
    changes.push({
      resource: 'scale',
      summary: `${desired.name}: region ${instance.region}, expected ${desired.expectedScale.region}`,
      service: desired.name,
      detail: 'Reported, never applied. Changing a region relocates a running service.',
      blocked: true,
    });
  }

  return changes;
}

/**
 * Diff the variables one service must carry.
 *
 * Two kinds, and the difference is the whole point:
 *
 *   - A variable declared WITH a value is configuration this repo owns. It is
 *     non-secret by construction (the value is in git), so the declared value may
 *     be printed and a mismatch is converged.
 *   - A variable declared by name only is unmanaged. It is reduced to
 *     set/absent/placeholder, never printed, and converged only when the caller
 *     supplied a value as RAILWAY_VAR_<NAME>. An existing value is never
 *     overwritten — this tool cannot clobber a working endpoint with stale config.
 *
 * Returns nothing for a service that does not exist — diffService already reported
 * that, and repeating it once per variable buries the real message.
 */
export function diffServiceVars(desired: ServiceDesired, live: LiveState, options: PlanOptions): PlannedChange[] {
  if (!isAsserted(desired)) return [];
  if (!findService(live, desired.name)) return [];

  const serviceVars = live.variables[desired.name] ?? {};
  const changes: PlannedChange[] = [];

  for (const required of desired.requiredVars) {
    const rawValue = serviceVars[required.name];
    const state = classifyVar(rawValue);

    if (required.value !== undefined) {
      if (rawValue === required.value) continue;
      changes.push({
        resource: 'env-var',
        summary:
          state === 'absent'
            ? `${desired.name}: ${required.name} is absent, declared "${required.value}"`
            : // Never the live value — only the declared one, which is already in git.
              `${desired.name}: ${required.name} differs from the declared "${required.value}"`,
        detail: `${required.reason}\nThis repo owns this value; --apply will set it.`,
        target: { serviceName: desired.name, varName: required.name },
      });
      continue;
    }

    if (state === 'set') continue;

    const supplied = options.suppliedVars.has(varKey(desired.name, required.name));

    changes.push({
      resource: 'env-var',
      summary: `${desired.name}: ${required.name} is ${state}`,
      detail:
        `${required.reason}\n` +
        (state === 'placeholder'
          ? 'The variable still holds an unfilled <placeholder> value and will fail at boot.'
          : 'The variable is not set on this service.') +
        `\n` +
        (supplied
          ? `A value is available as RAILWAY_VAR_${required.name}; --apply will set it.`
          : `No value available. Export RAILWAY_VAR_${required.name} to let --apply set it, ` +
            `or set it directly in Railway.`),
      target: { serviceName: desired.name, varName: required.name },
      // Convergeable only when the caller actually supplied a value. Without one
      // this is a report, not a fix — the tool never invents an unmanaged value.
      blocked: !supplied,
    });
  }

  for (const constrained of desired.optionalConstrainedVars ?? []) {
    const rawValue = serviceVars[constrained.name];
    const state = classifyVar(rawValue);
    if (state === 'absent') continue;

    const normalizedValue = rawValue?.trim();
    if (normalizedValue && constrained.allowedValues.includes(normalizedValue)) continue;

    const allowedValues = constrained.allowedValues.map((allowedValue) => `"${allowedValue}"`).join(' or ');
    changes.push({
      resource: 'env-var',
      summary: `${desired.name}: ${constrained.name} must be absent or ${allowedValues}`,
      detail:
        `${constrained.reason}\n` +
        `The variable is ${state === 'placeholder' ? 'an unfilled placeholder' : 'set to an unsupported value'}. ` +
        `Remove it or set it to ${allowedValues}.`,
      target: { serviceName: desired.name, varName: constrained.name },
      blocked: true,
    });
  }

  for (const constrained of desired.requiredConstrainedVars ?? []) {
    const rawValue = serviceVars[constrained.name];
    const normalizedValue = rawValue?.trim();
    if (normalizedValue && constrained.allowedValues.includes(normalizedValue)) continue;

    const state = classifyVar(rawValue);
    const allowedValues = constrained.allowedValues.map((allowedValue) => `"${allowedValue}"`).join(' or ');
    const liveDescription =
      state === 'absent'
        ? 'not set on this service'
        : state === 'placeholder'
          ? 'an unfilled placeholder'
          : 'set to an unsupported value (not printed)';
    changes.push({
      resource: 'env-var',
      summary: `${desired.name}: ${constrained.name} must be ${allowedValues}`,
      detail: `${constrained.reason}\nThe variable is ${liveDescription}. Set ${constrained.name} to ${allowedValues}.`,
      target: { serviceName: desired.name, varName: constrained.name },
      blocked: true,
    });
  }

  for (const requirement of desired.requiredOneOfVars ?? []) {
    const matchesExpectedValue = requirement.names.some(
      (name) => serviceVars[name]?.trim() === requirement.expectedValue,
    );
    if (matchesExpectedValue) continue;

    changes.push({
      resource: 'env-var',
      summary: `${desired.name}: one of ${requirement.names.join(' or ')} must equal ${requirement.expectedValue}`,
      detail:
        `${requirement.reason}\n` +
        `Set at least one listed variable to ${requirement.expectedValue}; the live value is not printed.`,
      blocked: true,
    });
  }

  return changes;
}

/**
 * Diff the variables that must stay unset.
 *
 * Always blocked: removing a variable is a delete, and the never-delete rule has no
 * exception. Reported loudly because the consequence is not cosmetic — handing
 * xprem an explicit signing keypair switches it off the DB-sealed key that is the
 * only copy in existence.
 */
export function diffForbiddenVars(desired: ServiceDesired, live: LiveState): PlannedChange[] {
  if (!isAsserted(desired) || !desired.forbiddenVars) return [];
  if (!findService(live, desired.name)) return [];

  const serviceVars = live.variables[desired.name] ?? {};

  return desired.forbiddenVars
    .filter((forbidden) => classifyVar(serviceVars[forbidden.name]) !== 'absent')
    .map((forbidden) => ({
      resource: 'env-var' as const,
      summary: `${desired.name}: ${forbidden.name} is set but must not be`,
      detail: `${forbidden.reason}\nRemove it in Railway. This tool never deletes a variable.`,
      blocked: true,
    }));
}

/**
 * Diff one table's retention against the live TTL expression.
 *
 * The comparison is intentionally loose — ClickHouse normalizes a TTL expression
 * when it stores it, so matching the column name and the day count is the honest
 * check. An exact string match would report drift on every server that formats it
 * differently.
 */
export function diffTableRetention(
  desired: TableRetentionDesired,
  liveExpression: string | undefined,
): PlannedChange | null {
  // toDateTime() is not cosmetic: these columns are DateTime64, and ClickHouse
  // rejects a TTL whose result is not Date or DateTime ("TTL expression result
  // column should have DateTime or Date type"). A remediation line that fails
  // when pasted is worse than none, so emit the form that actually runs. On a
  // plain DateTime column the wrapper is a no-op.
  const expected = `toDateTime(${desired.column}) + toIntervalDay(${desired.ttlDays})`;
  const fix = `ALTER TABLE ${desired.table} MODIFY TTL toDateTime(${desired.column}) + INTERVAL ${desired.ttlDays} DAY;`;

  if (liveExpression === undefined || liveExpression.trim() === '') {
    return {
      resource: 'clickhouse-ttl',
      summary: `${desired.table}: no TTL set`,
      detail: `${desired.reason}\n` + `Expected roughly: ${expected}\n` + `Fix: ${fix}`,
      blocked: true,
    };
  }

  const normalized = liveExpression.replace(/\s+/g, '');
  const mentionsColumn = normalized.includes(desired.column);
  const mentionsDays = new RegExp(`toIntervalDay\\(${desired.ttlDays}\\)`).test(normalized);
  if (mentionsColumn && mentionsDays) return null;

  return {
    resource: 'clickhouse-ttl',
    summary: `${desired.table}: TTL is not ${desired.ttlDays} days`,
    detail:
      `Live: ${liveExpression}\n` +
      `Expected roughly: ${expected}\n` +
      `A server upgrade can recreate these tables and drop a TTL we set out of band.\n` +
      `Fix: ${fix}`,
    blocked: true,
  };
}

/**
 * Diff the ClickHouse volume's utilisation against its declared budget.
 *
 * Reported as blocked because there is nothing this tool can safely do about it —
 * and, as it turns out, nothing it *could* do: Railway exposes no volume size on
 * any input type, so growing a volume is a dashboard action by construction.
 * Deleting data is a decision for a human either way.
 */
export function diffVolumeUsage(
  limitPercent: number,
  live: { usedMb: number; capacityMb: number } | null,
): PlannedChange | null {
  if (live === null || live.capacityMb <= 0) return null;

  const usedPercent = (live.usedMb / live.capacityMb) * 100;
  if (usedPercent < limitPercent) return null;

  const gb = (mb: number) => (mb / 1024).toFixed(1);
  return {
    resource: 'volume-usage',
    summary: `ClickHouse volume is ${usedPercent.toFixed(1)}% full (limit ${limitPercent}%)`,
    detail:
      `Using ${gb(live.usedMb)} GiB of ${gb(live.capacityMb)} GiB.\n` +
      `A full volume stops ClickHouse accepting writes, and xprem exits at boot when\n` +
      `ClickHouse is unreachable — so a full disk here also blocks the next OTA restart.\n` +
      `Fix: grow the volume in Railway, or shorten a retention window in config.ts.`,
    blocked: true,
  };
}

/** Whether a planned change would write to the OTA service if applied (or opted in). */
function writesOtaService(change: PlannedChange): boolean {
  const serviceName = change.service ?? change.target?.serviceName;
  if (serviceName !== OTA_SERVICE_NAME) return false;
  // An image move counts even while it waits for --allow-image-change: the
  // refusal must read the same in the nightly dry run as in the apply job.
  if (change.resource === 'service-image') return change.image !== undefined;
  return !change.blocked && (change.resource === 'deploy-setting' || change.resource === 'env-var');
}

/**
 * Refuse a ClickHouse image change in the same run as any write to the OTA server.
 *
 * xprem calls log.Fatalf at boot when ClickHouse is unreachable, so an OTA
 * deployment that lands while ClickHouse is restarting takes updates.boardsesh.com
 * down with it. That is not only the case where both images move: any OTA write
 * (image, deploy setting or variable) rolls an OTA deployment, and a failed batch
 * unwinds in reverse, so ClickHouse can be rolled back and the OTA server
 * restarted right after, before ClickHouse accepts connections again.
 *
 * Only a real ClickHouse image move (an entry carrying `image`) triggers this; a
 * blocked split or unreadable serving deployment already stops that service.
 * Every involved entry is blocked and its summary says why, because the SKIPPED
 * line prints only the summary.
 */
export function refuseClickHouseImageWithOtaWrites(changes: PlannedChange[]): PlannedChange[] {
  const changesClickHouseImage = changes.some(
    (change) => change.resource === 'service-image' && change.service === CLICKHOUSE_SERVICE_NAME && change.image,
  );
  if (!changesClickHouseImage || !changes.some(writesOtaService)) return changes;

  const refusal =
    `Refusing to change the ${CLICKHOUSE_SERVICE_NAME} image in the same run as a write to ` +
    `${OTA_SERVICE_NAME}: xprem exits at boot when ClickHouse is unreachable, and this run could ` +
    `restart the OTA server (its own deploy, or a rollback of it) while ClickHouse is restarting.\n` +
    `Fix: converge the OTA service first, then land the ClickHouse image change in a separate PR.`;
  return changes.map((change) => {
    const involved =
      writesOtaService(change) ||
      (change.resource === 'service-image' && change.service === CLICKHOUSE_SERVICE_NAME && change.image);
    if (!involved) return change;
    return {
      ...change,
      summary: `${change.summary} (refused: converge the OTA service first, then the ClickHouse image in a separate PR)`,
      detail: change.detail ? `${refusal}\n${change.detail}` : refusal,
      blocked: true,
    };
  });
}

/**
 * Build the full plan.
 *
 * Order is outside-in: whether the service exists, then what it runs, then how it
 * is deployed and reached, then what it carries, then the things asserted against
 * ClickHouse rather than Railway. A missing service explains its own missing
 * variables, and the retention and disk rows only make sense once ClickHouse
 * exists at all.
 */
export function buildPlan(desired: RailwayDesiredState, live: LiveState, options: PlanOptions): PlannedChange[] {
  const changes: PlannedChange[] = [];
  const missingInstances = new Set<string>();

  for (const service of desired.services) {
    const serviceChange = diffService(service, live);
    if (serviceChange) {
      changes.push(serviceChange);
    } else if (isAsserted(service) && live.instances[service.name] === null) {
      missingInstances.add(service.name);
      changes.push({
        resource: 'service-instance',
        service: service.name,
        summary: `${service.name}: instance is missing from environment "${desired.environmentName}"`,
        detail:
          'The project-level service exists, but this environment has no instance. ' +
          'Restore the intended instance and any persistent volume before applying configuration. ' +
          'No variables, settings, or deployments are written for this service; it is not created automatically.',
        blocked: true,
      });
    }
  }

  for (const service of desired.services) {
    if (missingInstances.has(service.name)) continue;
    const imageChange = diffServiceImage(service, live, options);
    if (imageChange) changes.push(imageChange);
    changes.push(...diffDeploySettings(service, live));
    changes.push(...diffCustomDomains(service, live));
    const volumeChange = diffVolumeMount(service, live);
    if (volumeChange) changes.push(volumeChange);
    changes.push(...diffScale(service, live));
  }

  for (const service of desired.services) {
    if (missingInstances.has(service.name)) continue;
    changes.push(...diffServiceVars(service, live, options));
    changes.push(...diffForbiddenVars(service, live));
  }

  // A null map means the check was skipped for want of a DSN, which must not read
  // as "retention is fine". The apply layer prints the skip separately.
  if (live.clickhouseTtl !== null) {
    for (const table of desired.clickhouseRetention) {
      const change = diffTableRetention(table, live.clickhouseTtl[table.table]);
      if (change) changes.push(change);
    }
  }

  const volumeUsageChange = diffVolumeUsage(desired.clickhouseVolumeUsageLimitPercent, live.clickhouseVolume);
  if (volumeUsageChange) changes.push(volumeUsageChange);

  return refuseClickHouseImageWithOtaWrites(changes);
}

/**
 * Live services this repo does not declare at all.
 *
 * Reported so a human can decide, never removed — the Railway project holds
 * Postgres and other services on purpose, and a tool that deleted what it did not
 * recognise would be a catastrophe rather than a convenience.
 *
 * Services listed as `inventory` count as declared. That is the point of the
 * inventory: so this reports a genuinely NEW service, which is worth seeing,
 * instead of the same three lines every night, which is not.
 */
export function undeclaredServices(desired: RailwayDesiredState, live: LiveState): string[] {
  const declared = new Set(desired.services.map((service) => service.name));
  return live.services.map((service) => service.name).filter((name) => !declared.has(name));
}

/** Services whose live instance configuration the tool needs to read. */
export function servicesNeedingInstanceRead(desired: RailwayDesiredState): string[] {
  return desired.services
    .filter(
      (service) =>
        isAsserted(service) &&
        (service.image || service.deploy || service.domains || service.volume || service.requiredVars.length > 0),
    )
    .map((service) => service.name);
}
