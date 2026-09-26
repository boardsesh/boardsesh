/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_WEB_ORIGIN,
  CLICKHOUSE_IMAGE,
  CLICKHOUSE_RETENTION,
  CLICKHOUSE_SERVICE_NAME,
  CLICKHOUSE_VOLUME_MOUNT_PATH,
  CLICKHOUSE_VOLUME_NAME,
  CLICKHOUSE_VOLUME_USAGE_LIMIT_PERCENT,
  INVENTORY_SERVICES,
  OTA_BASE_URL,
  OTA_CONTAINER_PORT,
  OTA_HEALTHCHECK_PATH,
  OTA_IMAGE,
  OTA_IMAGE_REPOSITORY,
  OTA_POSTGRES_SERVICE_NAME,
  OTA_POSTGRES_VOLUME_MOUNT_PATH,
  OTA_SERVER_VERSION,
  OTA_SERVICE_NAME,
  PLACEHOLDER_PATTERN,
  POSTGRES_PRIMARY_SERVICE_NAME,
  WEB_SERVICE_NAME,
  desiredRailwayState,
} from '../infra/railway/config';
import type { ServiceDesired } from '../infra/railway/config';
import {
  buildPlan,
  classifyVar,
  compareVersions,
  diffCustomDomains,
  diffDeploySettings,
  diffForbiddenVars,
  diffScale,
  diffService,
  diffServiceImage,
  diffServiceVars,
  diffTableRetention,
  diffVolumeMount,
  diffVolumeUsage,
  findService,
  imageVersion,
  servicesNeedingInstanceRead,
  undeclaredServices,
  varKey,
} from '../infra/railway/plan';
import type { LiveServiceInstance, LiveState, PlanOptions } from '../infra/railway/plan';
import { EOAS_PACKAGE_SPEC } from './lib/eoas';
import { RollbackFencedError } from './railway-deployment-rollback.mjs';
import {
  ACTIVE_DEPLOYMENT_STATUSES,
  DEPLOY_SUCCESS_CONFIRMATIONS,
  RAILWAY_API,
  canRollBack,
  collectSuppliedVars,
  fetchClickHouseTtl,
  fetchUpdateInputFields,
  fetchVolumes,
  isRollbackFenced,
  main,
  parseArgs,
  previousConfigurationInput,
  probeService,
  resetAuthScheme,
  rollbackAppliedDeployments,
  restoreConfiguration,
  suppliedVarKeys,
  ttlFromEngineFull,
  waitForDeployment,
} from './railway-apply';

/**
 * A value that is unmistakable in any output. Every secret-safety assertion looks
 * for this string rather than for a plausible-looking DSN, so a leak cannot hide
 * behind a value that merely resembles the real one.
 */
const SECRET_DSN = 'clickhouse://svc:hunter2@ch.railway.internal:9000/expo_observe';

// The OTA server's Redis cache settings, as production carries them.
const OTA_CACHE_VARS = {
  CACHE_MODE: 'redis',
  REDIS_HOST: 'redis.railway.internal',
  REDIS_PORT: '6379',
  REDIS_PASSWORD: 'test-redis-password',
  CACHE_KEY_PREFIX: 'boardsesh-ota',
};

/** The live value of an OWNED variable. The plan may print the declared value; never this one. */
const WRONG_OWNED_VALUE = 'wrong-value-sentinel';

/** Stands in for a secret that Railway holds and this repo does not. Deliberately not a `<placeholder>`. */
const SECRET_STAND_IN = 'held-in-railway';

/** The version of the eoas CLI this repo publishes with — the same value main() passes to the plan. */
const EOAS_VERSION = EOAS_PACKAGE_SPEC.replace(/^eoas@/, '');

const PLAN_OPTIONS: PlanOptions = { suppliedVars: new Set<string>(), eoasVersion: EOAS_VERSION };

function declaredService(name: string): ServiceDesired {
  const service = desiredRailwayState.services.find((candidate) => candidate.name === name);
  // A rename in config.ts should fail loudly here rather than silently skip a whole suite.
  if (!service) throw new Error(`config.ts no longer declares a service named "${name}"`);
  return service;
}

const OTA = declaredService(OTA_SERVICE_NAME);
const CLICKHOUSE = declaredService(CLICKHOUSE_SERVICE_NAME);
const POSTGRES = declaredService(OTA_POSTGRES_SERVICE_NAME);
const PRIMARY = declaredService(POSTGRES_PRIMARY_SERVICE_NAME);
const WEB = declaredService(WEB_SERVICE_NAME);

/** Stable fake Railway id for a declared service. Derived, so a renamed service cannot desync the fixtures. */
function liveServiceId(name: string): string {
  return `svc-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

const OTA_SERVICE_ID = liveServiceId(OTA_SERVICE_NAME);

function serviceNameById(id: string): string | undefined {
  return desiredRailwayState.services.find((service) => liveServiceId(service.name) === id)?.name;
}

/**
 * Every declared service as Railway would list it — including the inventory ones,
 * which are declared precisely so they do not read as undeclared.
 */
function convergedServices(): { id: string; name: string }[] {
  return desiredRailwayState.services.map((service) => ({ id: liveServiceId(service.name), name: service.name }));
}

/**
 * The variables a fully converged project would hold: every owned variable at the
 * value config.ts declares, every secret set to something that is neither empty nor
 * a placeholder.
 */
function convergedVariables(): Record<string, Record<string, string>> {
  const variables: Record<string, Record<string, string>> = {};
  for (const service of desiredRailwayState.services) {
    const serviceVariables = Object.fromEntries(
      service.requiredVars.map((required) => [required.name, required.value ?? SECRET_STAND_IN]),
    );
    for (const requirement of service.requiredOneOfVars ?? []) {
      serviceVariables[requirement.names[0]] = requirement.expectedValue;
    }
    for (const requirement of service.requiredConstrainedVars ?? []) {
      serviceVariables[requirement.name] = requirement.allowedValues[0];
    }
    variables[service.name] = serviceVariables;
  }
  return variables;
}

/** The OTA service's converged variables, with named overrides (`null` removes one). */
function otaVariables(overrides: Record<string, string | null> = {}): Record<string, string> {
  const variables = { ...convergedVariables()[OTA_SERVICE_NAME] };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete variables[name];
    else variables[name] = value;
  }
  return variables;
}

function variablesWithOta(ota: Record<string, string>): Record<string, Record<string, string>> {
  return { ...convergedVariables(), [OTA_SERVICE_NAME]: ota };
}

/** The instance state a service in sync with config.ts would report. */
function convergedInstance(service: ServiceDesired): LiveServiceInstance {
  return {
    image: service.image ?? null,
    healthcheckPath: service.deploy?.healthcheckPath ?? null,
    healthcheckTimeout: service.deploy?.healthcheckTimeout ?? null,
    restartPolicyType: service.deploy?.restartPolicyType ?? null,
    restartPolicyMaxRetries: service.deploy?.restartPolicyMaxRetries ?? null,
    drainingSeconds: service.deploy?.drainingSeconds ?? null,
    region: service.expectedScale?.region ?? null,
    numReplicas: service.expectedScale?.numReplicas ?? null,
    customDomains: (service.domains ?? []).map((domain) => ({ domain: domain.domain, targetPort: domain.targetPort })),
    volumeMountPaths: service.volume ? [service.volume.mountPath] : [],
    runningImage: service.image ?? null,
  };
}

function convergedInstances(): Record<string, LiveServiceInstance> {
  const instances: Record<string, LiveServiceInstance> = {};
  for (const name of servicesNeedingInstanceRead(desiredRailwayState)) {
    instances[name] = convergedInstance(declaredService(name));
  }
  return instances;
}

/**
 * A live project that matches config.ts exactly. Every field is derived from the
 * config exports, so a new declared service, variable, domain or deploy setting
 * lands in the fixture automatically instead of rotting into a false green.
 */
function liveState(overrides: Partial<LiveState> = {}): LiveState {
  return {
    services: convergedServices(),
    variables: convergedVariables(),
    instances: convergedInstances(),
    // 853 MiB of 50 GiB — the real reading when the volume was provisioned.
    clickhouseVolume: { usedMb: 853, capacityMb: 50000 },
    clickhouseTtl: Object.fromEntries(
      CLICKHOUSE_RETENTION.map((table) => [
        table.table,
        `toDateTime(${table.column}) + toIntervalDay(${table.ttlDays})`,
      ]),
    ),
    ...overrides,
  };
}

/** A live state where one service's instance differs from the declared shape. */
function withInstance(name: string, patch: Partial<LiveServiceInstance>): LiveState {
  const base = liveState();
  return {
    ...base,
    instances: { ...base.instances, [name]: { ...convergedInstance(declaredService(name)), ...patch } },
  };
}

describe('the in-sync fixture', () => {
  it('plans nothing at all, so every drift test below is measuring its own change', () => {
    expect(buildPlan(desiredRailwayState, liveState(), PLAN_OPTIONS)).toEqual([]);
  });

  it('covers every service config.ts declares', () => {
    expect(
      liveState()
        .services.map((service) => service.name)
        .sort(),
    ).toEqual(desiredRailwayState.services.map((service) => service.name).sort());
  });
});

describe('parseArgs', () => {
  it('defaults to a dry run that waits on any deployment it rolls', () => {
    expect(parseArgs([])).toEqual({ apply: false, allowImageChange: false, wait: true, help: false });
  });

  it('accepts --apply and the -- separator vp forwards', () => {
    expect(parseArgs(['--', '--apply'])).toEqual({ apply: true, allowImageChange: false, wait: true, help: false });
  });

  it('keeps the image opt-in separate from --apply, because rolling a container is the bigger act', () => {
    expect(parseArgs(['--apply', '--allow-image-change'])).toMatchObject({ apply: true, allowImageChange: true });
    expect(parseArgs(['--allow-image-change'])).toMatchObject({ apply: false, allowImageChange: true });
  });

  it('takes --no-wait for a local run that should not sit on a poll', () => {
    expect(parseArgs(['--apply', '--no-wait'])).toMatchObject({ apply: true, wait: false });
  });

  it('lets --dry-run cancel an earlier --apply', () => {
    expect(parseArgs(['--apply', '--dry-run'])).toMatchObject({ apply: false });
  });

  it('recognises both spellings of help', () => {
    expect(parseArgs(['--help'])).toMatchObject({ help: true });
    expect(parseArgs(['-h'])).toMatchObject({ help: true });
  });

  it('rejects a typo rather than silently dry-running', () => {
    expect(() => parseArgs(['--appply'])).toThrow(/Unknown flag/);
    expect(() => parseArgs(['--allow-image-changes'])).toThrow(/Unknown flag/);
  });
});

describe('classifyVar', () => {
  it('treats an unfilled eoas placeholder as not set', () => {
    expect(classifyVar('<clickhouse://user:password@host:9000/xprem>')).toBe('placeholder');
    expect(PLACEHOLDER_PATTERN.test('<clickhouse://user:password@host:9000/xprem>')).toBe(true);
  });

  it('treats undefined and whitespace as absent', () => {
    expect(classifyVar(undefined)).toBe('absent');
    expect(classifyVar('   ')).toBe('absent');
  });

  it('treats a real DSN as set', () => {
    expect(classifyVar('clickhouse://u:p@host:9000/expo_observe')).toBe('set');
  });
});

describe('findService', () => {
  it('matches by name', () => {
    expect(findService(liveState(), OTA_SERVICE_NAME)?.id).toBe(OTA_SERVICE_ID);
    expect(findService(liveState(), 'nope')).toBeNull();
  });
});

describe('diffService', () => {
  it('is silent when the service exists', () => {
    expect(diffService(OTA, liveState())).toBeNull();
  });

  it('blocks rather than creates a missing stateful service', () => {
    const live = liveState({ services: convergedServices().filter((service) => service.name !== CLICKHOUSE.name) });
    const change = diffService(CLICKHOUSE, live);
    expect(change).toMatchObject({ resource: 'service', blocked: true });
    expect(change?.detail).toMatch(/persistent volume/);
  });

  it('says nothing about an inventory service, which is somebody else’s on purpose', () => {
    const live = liveState({ services: [] });
    for (const service of INVENTORY_SERVICES) expect(diffService(service, live)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders the dotted prerelease spelling upstream used at 3.0.0', () => {
    expect(compareVersions('3.0.0-beta.3', '3.0.0-beta.4')).toBeLessThan(0);
    expect(compareVersions('3.0.0-beta.10', '3.0.0-beta.9')).toBeGreaterThan(0);
  });

  it('orders the undotted spelling upstream switched to at 3.1.2', () => {
    expect(compareVersions('3.1.2-beta2', '3.1.2-beta4')).toBeLessThan(0);
    expect(compareVersions('3.2.0-beta1', '3.2.0-beta2')).toBeLessThan(0);
  });

  it('ranks a prerelease below the release it leads to', () => {
    expect(compareVersions('3.1.2-beta4', '3.1.2')).toBeLessThan(0);
    expect(compareVersions('3.0.0-beta.3', '3.0.0')).toBeLessThan(0);
  });

  it('orders the releases this repo has actually run', () => {
    expect(compareVersions('3.1.2', '3.1.3')).toBeLessThan(0);
    expect(compareVersions('3.1.3', '3.2.0-beta1')).toBeLessThan(0);
    expect(compareVersions('3.0.5', '3.1.2')).toBeLessThan(0);
  });

  it('ranks a numeric identifier below an alphanumeric one, as semver requires', () => {
    expect(compareVersions('3.0.0-1', '3.0.0-alpha')).toBeLessThan(0);
    expect(compareVersions('3.0.0-alpha', '3.0.0-1')).toBeGreaterThan(0);
  });

  it('ignores a leading v, so a tag and a version string compare equal', () => {
    expect(compareVersions('v3.1.2', '3.1.2')).toBe(0);
    expect(compareVersions('3.1.2', '3.1.2')).toBe(0);
  });
});

describe('imageVersion', () => {
  it('reads the tag off the image config.ts declares', () => {
    expect(imageVersion(OTA_IMAGE)).toBe(OTA_SERVER_VERSION);
    expect(imageVersion('ghcr.io/mercuretechnologies/expo-open-ota:v3.1.2')).toBe('3.1.2');
  });

  it('keeps the prerelease suffix, which is what the CLI-must-not-trail check compares', () => {
    expect(imageVersion(`${OTA_IMAGE_REPOSITORY}:v3.2.0-beta3`)).toBe('3.2.0-beta3');
  });

  it('returns null for a digest or a bare name rather than inventing a version', () => {
    expect(imageVersion(`${OTA_IMAGE_REPOSITORY}@sha256:3f1c0aeb9d2f4c5b6a7d8e9f0a1b2c3d`)).toBeNull();
    expect(imageVersion(OTA_IMAGE_REPOSITORY)).toBeNull();
    // Two-part tags (the ClickHouse image) are not versions this tool can rank.
    expect(imageVersion(CLICKHOUSE_IMAGE)).toBeNull();
  });
});

describe('classifyVar and the placeholder pattern', () => {
  it('does not mistake a real password containing angle brackets for a placeholder', () => {
    // ADMIN_PASSWORD is the one variable whose documented policy REQUIRES a symbol,
    // so `hunter<2>!Ab` is plausible. Misreading it as a placeholder is not
    // cosmetic: it makes the variable convergeable, so a supplied value would
    // overwrite a working secret — breaking the rule that a set secret is never
    // clobbered.
    expect(classifyVar('hunter<2>!Ab')).toBe('set');
    expect(classifyVar('a<b>c')).toBe('set');
  });

  it('still catches the whole-value placeholder eoas server:init writes', () => {
    expect(classifyVar('<clickhouse://user:password@host:9000/xprem>')).toBe('placeholder');
    expect(classifyVar('  <clickhouse://user:password@host:9000/xprem>  ')).toBe('placeholder');
  });

  it('never reports a placeholder-shaped secret as convergeable without a supplied value', () => {
    const live = liveState({ variables: variablesWithOta(otaVariables({ ADMIN_PASSWORD: 'hunter<2>!Ab' })) });
    const changes = diffServiceVars(OTA, live, { suppliedVars: new Set<string>() });
    expect(changes.filter((change) => change.summary.includes('ADMIN_PASSWORD'))).toEqual([]);
  });
});

describe('diffServiceImage', () => {
  it.each(['25.3', '25.3.1'])('does not compare ClickHouse %s against the unrelated eoas version', (tag) => {
    const service = { ...CLICKHOUSE, image: `clickhouse/clickhouse-server:${tag}` };
    const live = withInstance(CLICKHOUSE_SERVICE_NAME, {
      image: 'clickhouse/clickhouse-server:24.1',
      runningImage: 'clickhouse/clickhouse-server:24.1',
    });
    const allowed = diffServiceImage(service, live, { ...PLAN_OPTIONS, allowImageChange: true });
    expect(allowed).toMatchObject({ resource: 'service-image', image: service.image });
    expect(allowed?.blocked).toBeFalsy();

    const withoutOptIn = diffServiceImage(service, live, PLAN_OPTIONS);
    expect(withoutOptIn?.blocked).toBe(true);
    expect(withoutOptIn?.detail).toContain('--allow-image-change');
  });

  it('blocks a tag it cannot read a version out of, rather than waving it through', () => {
    // Treating "cannot tell" as "must be fine" would disable the CLI-must-not-trail
    // guard for exactly the tags that skip it: :latest, :v3.2, a bare digest.
    for (const tag of ['latest', 'v3.2']) {
      const service = { ...OTA, image: `${OTA_IMAGE_REPOSITORY}:${tag}` };
      const change = diffServiceImage(service, liveState(), {
        suppliedVars: new Set<string>(),
        allowImageChange: true,
        eoasVersion: '3.1.2',
      });
      expect(change, tag).toMatchObject({ resource: 'service-image', blocked: true });
      expect(change?.detail, tag).toMatch(/cannot read a version/i);
    }
  });

  it('reports a service configured for the declared image but running another one', () => {
    // The state a run that died between serviceInstanceUpdate and
    // serviceInstanceDeployV2 leaves behind. Reading only the configured image
    // would call this in sync forever, while the next unrelated deploy shipped the
    // never-probed image.
    const change = diffServiceImage(
      OTA,
      withInstance(OTA_SERVICE_NAME, { runningImage: `${OTA_IMAGE_REPOSITORY}:v3.0.5` }),
      { suppliedVars: new Set<string>(), allowImageChange: true, eoasVersion: '3.1.2' },
    );

    expect(change).toMatchObject({ resource: 'service-image', blocked: true });
    expect(change?.summary).toMatch(/configured for .* but running /);
  });

  it('blocks a configured-versus-running split even when the repo declares a third image', () => {
    // Configured for B, serving A, declared C. Deploying C here would, on failure,
    // roll back to serving A while restoring configured B, so the next deploy for
    // any reason would ship B unprobed.
    const configuredImage = `${OTA_IMAGE_REPOSITORY}:v3.0.6`;
    const servingImage = `${OTA_IMAGE_REPOSITORY}:v3.0.5`;
    const change = diffServiceImage(
      OTA,
      withInstance(OTA_SERVICE_NAME, { image: configuredImage, runningImage: servingImage }),
      { ...PLAN_OPTIONS, allowImageChange: true },
    );

    expect(change).toMatchObject({ resource: 'service-image', blocked: true, service: OTA_SERVICE_NAME });
    expect(change?.image).toBeUndefined();
    expect(change?.summary).toContain(`configured for ${configuredImage} but running ${servingImage}`);
  });

  const driftedImage = `${OTA_IMAGE_REPOSITORY}:v3.0.5`;

  it('is silent when the running image is the declared one', () => {
    expect(diffServiceImage(OTA, liveState(), PLAN_OPTIONS)).toBeNull();
  });

  it('blocks an image change nobody asked for, since it rolls the server every binary talks to', () => {
    const change = diffServiceImage(
      OTA,
      withInstance(OTA_SERVICE_NAME, { image: driftedImage, runningImage: driftedImage }),
      PLAN_OPTIONS,
    );
    expect(change).toMatchObject({ resource: 'service-image', blocked: true, service: OTA_SERVICE_NAME });
    expect(change?.image).toBe(OTA_IMAGE);
    expect(change?.detail).toMatch(/--allow-image-change/);
  });

  it('unblocks the same change once the caller opted in', () => {
    const change = diffServiceImage(
      OTA,
      withInstance(OTA_SERVICE_NAME, { image: driftedImage, runningImage: driftedImage }),
      {
        ...PLAN_OPTIONS,
        allowImageChange: true,
      },
    );
    expect(change?.blocked).toBeFalsy();
    expect(change?.image).toBe(OTA_IMAGE);
  });

  it('blocks a server that would outrank the CLI this repo publishes with, opt-in or not', () => {
    // The standing rule: the CLI may lead the server, never trail it — a trailing
    // CLI can 404 on app-scoped routes.
    const ahead: ServiceDesired = { ...OTA, image: `${OTA_IMAGE_REPOSITORY}:v3.9.9` };
    const change = diffServiceImage(ahead, liveState(), {
      suppliedVars: new Set<string>(),
      allowImageChange: true,
      eoasVersion: '3.1.2',
    });
    expect(change).toMatchObject({ resource: 'service-image', blocked: true });
    expect(change?.detail).toMatch(/eoas 3\.1\.2/);
    expect(change?.detail).toMatch(/EOAS_PACKAGE_SPEC/);
  });

  it('says nothing for a service whose instance was never read', () => {
    expect(diffServiceImage(OTA, liveState({ instances: {} }), PLAN_OPTIONS)).toBeNull();
  });
});

describe('diffDeploySettings', () => {
  it('is silent when every field matches', () => {
    expect(diffDeploySettings(OTA, liveState())).toEqual([]);
  });

  it('emits one change per differing field, so the plan names what moves', () => {
    const changes = diffDeploySettings(
      OTA,
      withInstance(OTA_SERVICE_NAME, { healthcheckTimeout: 300, drainingSeconds: 0 }),
    );
    expect(changes).toHaveLength(2);
    const fields = changes.map((change) => String(change.deployField?.name));
    expect(fields.sort((left, right) => left.localeCompare(right))).toEqual(['drainingSeconds', 'healthcheckTimeout']);
    for (const change of changes) {
      expect(change).toMatchObject({ resource: 'deploy-setting', service: OTA_SERVICE_NAME });
      expect(change.blocked).toBeFalsy();
    }
  });

  it('ignores the retry count under ALWAYS, whatever Railway stores for it', () => {
    expect(OTA.deploy?.restartPolicyType).toBe('ALWAYS');
    for (const storedRetries of [10, null, 0]) {
      const changes = diffDeploySettings(
        OTA,
        withInstance(OTA_SERVICE_NAME, { restartPolicyMaxRetries: storedRetries }),
      );
      expect(changes, String(storedRetries)).toEqual([]);
    }
  });

  it('still converges the retry count under ON_FAILURE, where it caps restarts', () => {
    const onFailure: ServiceDesired = {
      ...OTA,
      deploy: {
        ...(OTA.deploy as NonNullable<ServiceDesired['deploy']>),
        restartPolicyType: 'ON_FAILURE',
        restartPolicyMaxRetries: 3,
      },
    };
    const live = withInstance(OTA_SERVICE_NAME, { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 });
    expect(diffDeploySettings(onFailure, live).map((change) => change.deployField)).toEqual([
      { name: 'restartPolicyMaxRetries', value: 3 },
    ]);
  });

  it('explains why a missing healthcheck matters, and carries the value to write', () => {
    const [change] = diffDeploySettings(OTA, withInstance(OTA_SERVICE_NAME, { healthcheckPath: null }));
    expect(change.deployField).toEqual({ name: 'healthcheckPath', value: OTA_HEALTHCHECK_PATH });
    expect(change.summary).toContain('(unset)');
    expect(change.detail).toMatch(/wedged boot/);
  });

  it('explains that Railway defaults draining to 0s, severing in-flight requests', () => {
    const [change] = diffDeploySettings(OTA, withInstance(OTA_SERVICE_NAME, { drainingSeconds: 0 }));
    expect(change.detail).toMatch(/severing in-flight requests/);
  });
});

describe('diffCustomDomains', () => {
  it('is silent when the declared domain is live on the declared port', () => {
    expect(diffCustomDomains(OTA, liveState())).toEqual([]);
  });

  it('blocks a missing domain instead of creating half a change', () => {
    const [change] = diffCustomDomains(OTA, withInstance(OTA_SERVICE_NAME, { customDomains: [] }));
    expect(change).toMatchObject({ resource: 'domain', blocked: true });
    expect(change.detail).toMatch(/DNS/);
    expect(change.detail).toMatch(/cloudflare/);
  });

  it('blocks a retargeted port rather than moving the domain every binary talks to', () => {
    const [change] = diffCustomDomains(
      OTA,
      withInstance(OTA_SERVICE_NAME, { customDomains: [{ domain: 'updates.boardsesh.com', targetPort: 3000 }] }),
    );
    expect(change).toMatchObject({ resource: 'domain', blocked: true });
    expect(change.summary).toContain(`declared ${OTA_CONTAINER_PORT}`);
  });

  it('reports an extra live domain and never proposes removing it', () => {
    const live = withInstance(OTA_SERVICE_NAME, {
      customDomains: [
        { domain: 'updates.boardsesh.com', targetPort: OTA_CONTAINER_PORT },
        { domain: 'ota-old.boardsesh.com', targetPort: OTA_CONTAINER_PORT },
      ],
    });
    const [change] = diffCustomDomains(OTA, live);
    expect(change).toMatchObject({ resource: 'domain', blocked: true });
    expect(change.summary).toContain('ota-old.boardsesh.com');
    expect(change.detail).toMatch(/Left alone/);
  });
});

describe('diffVolumeMount', () => {
  it('is silent when the volume is mounted where it belongs', () => {
    expect(diffVolumeMount(CLICKHOUSE, liveState())).toBeNull();
    expect(diffVolumeMount(POSTGRES, liveState())).toBeNull();
  });

  it('blocks and lists what IS mounted, because a detached volume looks perfectly healthy', () => {
    const change = diffVolumeMount(CLICKHOUSE, withInstance(CLICKHOUSE_SERVICE_NAME, { volumeMountPaths: ['/data'] }));
    expect(change).toMatchObject({ resource: 'volume', blocked: true, service: CLICKHOUSE_SERVICE_NAME });
    expect(change?.summary).toContain(CLICKHOUSE_VOLUME_MOUNT_PATH);
    expect(change?.detail).toContain('Mounted: /data');
  });

  it('says "(none)" rather than an empty line when nothing is mounted', () => {
    const change = diffVolumeMount(POSTGRES, withInstance(OTA_POSTGRES_SERVICE_NAME, { volumeMountPaths: [] }));
    expect(change?.detail).toContain('(none)');
    expect(change?.summary).toContain(OTA_POSTGRES_VOLUME_MOUNT_PATH);
  });
});

describe('diffScale', () => {
  it('is silent at the declared replica count and region', () => {
    expect(diffScale(OTA, liveState())).toEqual([]);
  });

  it('reports a second replica and blocks it, since CACHE_MODE=local is only correct at one', () => {
    const [change] = diffScale(OTA, withInstance(OTA_SERVICE_NAME, { numReplicas: 2 }));
    expect(change).toMatchObject({ resource: 'scale', blocked: true });
    expect(change.summary).toContain('2 replicas');
  });

  it('reports a moved region and blocks it, since applying one relocates a running service', () => {
    const [change] = diffScale(OTA, withInstance(OTA_SERVICE_NAME, { region: 'europe-west4' }));
    expect(change).toMatchObject({ resource: 'scale', blocked: true });
    expect(change.detail).toMatch(/relocates a running service/);
  });

  it('says nothing when Railway reports no scale at all, rather than inventing drift', () => {
    expect(diffScale(OTA, withInstance(OTA_SERVICE_NAME, { numReplicas: null, region: null }))).toEqual([]);
  });
});

describe('diffServiceVars', () => {
  it('is silent when every declared variable is set at its declared value', () => {
    expect(diffServiceVars(OTA, liveState(), PLAN_OPTIONS)).toEqual([]);
  });

  it('reports an absent secret and blocks it when no value was supplied', () => {
    const live = liveState({ variables: variablesWithOta(otaVariables({ CLICKHOUSE_URL: null })) });
    const [change] = diffServiceVars(OTA, live, PLAN_OPTIONS);
    expect(change).toMatchObject({ resource: 'env-var', blocked: true });
    expect(change.summary).toContain('absent');
  });

  it('unblocks the change when the caller supplied a value', () => {
    const live = liveState({ variables: variablesWithOta(otaVariables({ CLICKHOUSE_URL: null })) });
    const [change] = diffServiceVars(OTA, live, {
      ...PLAN_OPTIONS,
      suppliedVars: new Set([varKey(OTA_SERVICE_NAME, 'CLICKHOUSE_URL')]),
    });
    expect(change.blocked).toBe(false);
    expect(change.detail).toMatch(/RAILWAY_VAR_CLICKHOUSE_URL/);
  });

  it('reports each absent TLS variable on the primary', () => {
    const variables = convergedVariables();
    variables[POSTGRES_PRIMARY_SERVICE_NAME] = {};

    const changes = diffServiceVars(PRIMARY, liveState({ variables }), PLAN_OPTIONS);
    expect(changes.map((change) => change.summary)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('PG_TLS_SERVER_CERT is absent'),
        expect.stringContaining('PG_TLS_SERVER_KEY is absent'),
      ]),
    );
    expect(changes.every((change) => change.blocked)).toBe(true);
  });

  it('flags a placeholder TLS certificate on the primary', () => {
    const variables = convergedVariables();
    variables[POSTGRES_PRIMARY_SERVICE_NAME] = {
      PG_TLS_SERVER_CERT: '<-----BEGIN CERTIFICATE----- …>',
      PG_TLS_SERVER_KEY: '-----BEGIN PRIVATE KEY-----\nreal\n-----END PRIVATE KEY-----',
    };

    const changes = diffServiceVars(PRIMARY, liveState({ variables }), PLAN_OPTIONS);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.summary).toContain('PG_TLS_SERVER_CERT');
    expect(changes[0]?.summary).toContain('placeholder');
  });

  it('never echoes a placeholder primary key in the plan', () => {
    const secretMarker = 'SUPERSECRETKEYMATERIAL';
    const variables = convergedVariables();
    variables[POSTGRES_PRIMARY_SERVICE_NAME] = { PG_TLS_SERVER_KEY: `<${secretMarker}>` };

    const changes = diffServiceVars(PRIMARY, liveState({ variables }), PLAN_OPTIONS);
    expect(changes.some((change) => change.summary.includes('placeholder'))).toBe(true);
    expect(JSON.stringify(changes)).not.toContain(secretMarker);
  });

  it('stays silent, and leaks nothing, when the primary TLS pair is set', () => {
    const secretMarker = 'SECRETBODY';
    const variables = convergedVariables();
    variables[POSTGRES_PRIMARY_SERVICE_NAME] = {
      PG_TLS_SERVER_CERT: `-----BEGIN CERTIFICATE-----\n${secretMarker}\n-----END CERTIFICATE-----`,
      PG_TLS_SERVER_KEY: `-----BEGIN PRIVATE KEY-----\n${secretMarker}\n-----END PRIVATE KEY-----`,
    };

    const changes = diffServiceVars(PRIMARY, liveState({ variables }), PLAN_OPTIONS);
    expect(changes).toEqual([]);
    expect(JSON.stringify(changes)).not.toContain(secretMarker);
  });

  it('flags a placeholder that a naive is-it-set check would pass', () => {
    const live = liveState({
      variables: variablesWithOta(otaVariables({ CLICKHOUSE_URL: '<clickhouse://user:password@host:9000/xprem>' })),
    });
    const [change] = diffServiceVars(OTA, live, PLAN_OPTIONS);
    expect(change.summary).toContain('placeholder');
  });

  /** A converged OTA service whose cache variables are exactly `cacheVars`. */
  function otaLive(cacheVars: Record<string, string>) {
    const withoutCache = otaVariables(Object.fromEntries(Object.keys(OTA_CACHE_VARS).map((name) => [name, null])));
    return liveState({ variables: variablesWithOta({ ...withoutCache, ...cacheVars }) });
  }

  it('blocks a missing CACHE_MODE and says to set it, never to remove it', () => {
    const { CACHE_MODE: _cacheMode, ...withoutCacheMode } = OTA_CACHE_VARS;
    const changes = diffServiceVars(OTA, otaLive(withoutCacheMode), PLAN_OPTIONS);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ resource: 'env-var', blocked: true });
    expect(changes[0]?.summary).toBe(`${OTA_SERVICE_NAME}: CACHE_MODE must be "redis"`);
    expect(changes[0]?.detail).toContain('1.7 GB');
    expect(changes[0]?.detail).toContain('not set on this service');
    expect(changes[0]?.detail).toContain('Set CACHE_MODE to "redis".');
    expect(changes[0]?.detail).not.toMatch(/remove|absent or/i);
  });

  it('rejects CACHE_MODE=local, the setting that grew the heap', () => {
    const changes = diffServiceVars(OTA, otaLive({ ...OTA_CACHE_VARS, CACHE_MODE: 'local' }), PLAN_OPTIONS);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.summary).toBe(`${OTA_SERVICE_NAME}: CACHE_MODE must be "redis"`);
    expect(changes[0]?.detail).toContain('Set CACHE_MODE to "redis".');
    expect(changes[0]?.detail).not.toMatch(/remove/i);
    expect(changes[0]?.blocked).toBe(true);
  });

  it('blocks a missing CACHE_KEY_PREFIX with the set-to remediation', () => {
    const { CACHE_KEY_PREFIX: _prefix, ...withoutPrefix } = OTA_CACHE_VARS;
    const changes = diffServiceVars(OTA, otaLive(withoutPrefix), PLAN_OPTIONS);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.summary).toBe(`${OTA_SERVICE_NAME}: CACHE_KEY_PREFIX must be "boardsesh-ota"`);
    expect(changes[0]?.detail).toContain('Set CACHE_KEY_PREFIX to "boardsesh-ota".');
    expect(changes[0]?.blocked).toBe(true);
  });

  it('blocks any other CACHE_KEY_PREFIX, which would silently move every key', () => {
    const changes = diffServiceVars(
      OTA,
      otaLive({ ...OTA_CACHE_VARS, CACHE_KEY_PREFIX: 'staging-ota-prefix' }),
      PLAN_OPTIONS,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.summary).toBe(`${OTA_SERVICE_NAME}: CACHE_KEY_PREFIX must be "boardsesh-ota"`);
    expect(changes[0]?.detail).toContain('set to an unsupported value');
    expect(`${changes[0]?.summary}\n${changes[0]?.detail}`).not.toContain('staging-ota-prefix');
    expect(changes[0]?.blocked).toBe(true);
  });

  it('reports no drift when CACHE_MODE and CACHE_KEY_PREFIX hold the exact values', () => {
    expect(diffServiceVars(OTA, otaLive(OTA_CACHE_VARS), PLAN_OPTIONS)).toEqual([]);
  });

  it('reports each missing Redis connection variable', () => {
    const summaries = diffServiceVars(
      OTA,
      otaLive({ CACHE_MODE: 'redis', CACHE_KEY_PREFIX: 'boardsesh-ota' }),
      PLAN_OPTIONS,
    ).map((change) => change.summary);
    expect(summaries).toEqual([
      `${OTA_SERVICE_NAME}: REDIS_HOST is absent`,
      `${OTA_SERVICE_NAME}: REDIS_PORT is absent`,
      `${OTA_SERVICE_NAME}: REDIS_PASSWORD is absent`,
    ]);
  });

  it('accepts unrendered ${{Redis.*}} reference templates as set, not as placeholders', () => {
    const live = otaLive({
      ...OTA_CACHE_VARS,
      REDIS_HOST: '${{Redis.REDISHOST}}',
      REDIS_PORT: '${{Redis.REDISPORT}}',
      REDIS_PASSWORD: '${{Redis.REDISPASSWORD}}',
    });
    expect(diffServiceVars(OTA, live, PLAN_OPTIONS)).toEqual([]);
  });

  it('stays quiet about variables on a service that does not exist', () => {
    expect(diffServiceVars(OTA, liveState({ services: [] }), PLAN_OPTIONS)).toEqual([]);
  });

  it('never puts the live value of a secret in the plan, not even a placeholder one', () => {
    const live = liveState({ variables: variablesWithOta(otaVariables({ CLICKHOUSE_URL: `<${SECRET_DSN}>` })) });
    const changes = diffServiceVars(OTA, live, PLAN_OPTIONS);
    expect(JSON.stringify(changes)).not.toContain('hunter2');
    expect(JSON.stringify(changes)).not.toContain(SECRET_DSN);
  });

  it('never overwrites a secret that is already set, whatever it holds', () => {
    // The rule that stops this tool clobbering a working DSN with a stale one.
    const live = liveState({ variables: variablesWithOta(otaVariables({ CLICKHOUSE_URL: SECRET_DSN })) });
    expect(diffServiceVars(OTA, live, PLAN_OPTIONS)).toEqual([]);
  });

  it('preserves an existing R2 endpoint without requiring its value in git', () => {
    const r2Endpoint = 'https://account-id.r2.cloudflarestorage.com';
    const live = liveState({ variables: variablesWithOta(otaVariables({ AWS_BASE_ENDPOINT: r2Endpoint })) });

    expect(diffServiceVars(OTA, live, PLAN_OPTIONS)).toEqual([]);
  });

  it.each([
    ['absent', null],
    ['placeholder', '<S3-compatible endpoint>'],
  ])('blocks an %s AWS_BASE_ENDPOINT until an endpoint is supplied', (_state, endpoint) => {
    const live = liveState({ variables: variablesWithOta(otaVariables({ AWS_BASE_ENDPOINT: endpoint })) });
    const change = diffServiceVars(OTA, live, PLAN_OPTIONS).find(
      (candidate) => candidate.target?.varName === 'AWS_BASE_ENDPOINT',
    );

    expect(change).toMatchObject({ resource: 'env-var', blocked: true });
    expect(JSON.stringify(change)).not.toContain('t3.storage.dev');
  });

  it('converges an owned variable, printing the declared value and never the live one', () => {
    const live = liveState({ variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })) });
    const [change] = diffServiceVars(OTA, live, PLAN_OPTIONS);
    expect(change).toMatchObject({
      resource: 'env-var',
      target: { serviceName: OTA_SERVICE_NAME, varName: 'BASE_URL' },
    });
    // Owned means convergeable: no supplied value needed, because the value is in git.
    expect(change.blocked).toBeFalsy();
    expect(change.summary).toContain(OTA_BASE_URL);
    expect(JSON.stringify(change)).not.toContain(WRONG_OWNED_VALUE);
  });

  it('reports an absent owned variable with the value it will write', () => {
    const live = liveState({ variables: variablesWithOta(otaVariables({ STORAGE_MODE: null })) });
    const [change] = diffServiceVars(OTA, live, PLAN_OPTIONS);
    expect(change.summary).toContain('is absent');
    expect(change.summary).toContain('"s3"');
    expect(change.blocked).toBeFalsy();
  });

  it('converges surrounding whitespace on an owned value because ownership is byte-exact', () => {
    const live = liveState({ variables: variablesWithOta(otaVariables({ BASE_URL: `  ${OTA_BASE_URL}  ` })) });
    const [change] = diffServiceVars(OTA, live, PLAN_OPTIONS);
    expect(change).toMatchObject({ resource: 'env-var', target: { varName: 'BASE_URL' } });
  });

  it('reports missing web SMTP credentials', () => {
    const variables = convergedVariables();
    variables[WEB_SERVICE_NAME] = { BASE_URL: CANONICAL_WEB_ORIGIN };

    const changes = diffServiceVars(WEB, liveState({ variables }), PLAN_OPTIONS);
    expect(changes.map((change) => change.summary)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('SMTP_USER is absent'),
        expect.stringContaining('SMTP_PASSWORD is absent'),
      ]),
    );
  });

  it('allows an absent BOARDSESH_WEB override', () => {
    expect(diffServiceVars(WEB, liveState(), PLAN_OPTIONS)).toEqual([]);
  });

  it('reports a non-one BOARDSESH_WEB override without printing it', () => {
    const unsupportedOverride = 'turn-off-the-auth-bridge';
    const variables = convergedVariables();
    variables[WEB_SERVICE_NAME] = { ...variables[WEB_SERVICE_NAME], BOARDSESH_WEB: unsupportedOverride };

    const changes = diffServiceVars(WEB, liveState({ variables }), PLAN_OPTIONS);
    expect(JSON.stringify(changes)).not.toContain(unsupportedOverride);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ summary: expect.stringContaining('BOARDSESH_WEB must be absent or "1"') }),
      ]),
    );
  });

  it('requires a canonical NEXTAUTH_URL or BASE_URL without printing the live URL', () => {
    const wrongOrigin = 'https://attacker.example';
    const variables = convergedVariables();
    variables[WEB_SERVICE_NAME] = {
      ...variables[WEB_SERVICE_NAME],
      NEXTAUTH_URL: wrongOrigin,
      BASE_URL: wrongOrigin,
    };

    const changes = diffServiceVars(WEB, liveState({ variables }), PLAN_OPTIONS);
    expect(JSON.stringify(changes)).not.toContain(wrongOrigin);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ summary: expect.stringContaining('NEXTAUTH_URL or BASE_URL') }),
      ]),
    );
  });
});

describe('diffForbiddenVars', () => {
  it('is silent while the forbidden variables stay unset', () => {
    expect(diffForbiddenVars(OTA, liveState())).toEqual([]);
  });

  it('blocks a set PRIVATE_EXPO_KEY_B64, which would strand the only copy of the signing key', () => {
    const live = liveState({
      variables: variablesWithOta(otaVariables({ PRIVATE_EXPO_KEY_B64: 'hunter2-signing-key' })),
    });
    const [change] = diffForbiddenVars(OTA, live);
    expect(change).toMatchObject({ resource: 'env-var', blocked: true });
    expect(change.summary).toContain('PRIVATE_EXPO_KEY_B64');
    expect(change.detail).toMatch(/never deletes a variable/);
    // A forbidden variable's value is still a secret.
    expect(JSON.stringify(change)).not.toContain('hunter2');
  });

  it('blocks every other control-plane switch too, and always reports rather than removes', () => {
    const live = liveState({
      variables: variablesWithOta(otaVariables({ KEYS_STORAGE_TYPE: 'local', EXPO_APP_ID: 'app-1' })),
    });
    const changes = diffForbiddenVars(OTA, live);
    expect(changes).toHaveLength(2);
    expect(changes.every((change) => change.blocked === true)).toBe(true);
  });

  it('says nothing for a service that does not exist', () => {
    expect(diffForbiddenVars(OTA, liveState({ services: [] }))).toEqual([]);
  });
});

describe('diffTableRetention', () => {
  const metrics = CLICKHOUSE_RETENTION[0];

  it('accepts a matching TTL regardless of whitespace', () => {
    expect(diffTableRetention(metrics, 'timestamp  +  toIntervalDay(90)')).toBeNull();
  });

  it('reports a table with no TTL at all', () => {
    const change = diffTableRetention(metrics, '');
    expect(change).toMatchObject({ resource: 'clickhouse-ttl', blocked: true });
    expect(change?.detail).toMatch(/ALTER TABLE observe_metrics MODIFY TTL/);
  });

  it('reports a TTL that drifted to a different window', () => {
    const change = diffTableRetention(metrics, 'timestamp + toIntervalDay(7)');
    expect(change?.summary).toContain('not 90 days');
  });
});

describe('the retention remediation line', () => {
  // ClickHouse rejects a TTL on a DateTime64 column, and both of these are
  // DateTime64(9). A Fix: line that fails when pasted is worse than none.
  it('wraps the column so the suggested ALTER actually runs', () => {
    const change = diffTableRetention(CLICKHOUSE_RETENTION[0], '');
    expect(change?.detail).toContain(`MODIFY TTL toDateTime(${CLICKHOUSE_RETENTION[0].column})`);
  });

  it('suggests the same form when the window is merely wrong', () => {
    const change = diffTableRetention(CLICKHOUSE_RETENTION[1], 'toDateTime(timestamp) + toIntervalDay(31)');
    expect(change?.detail).toContain('MODIFY TTL toDateTime(timestamp)');
  });
});

describe('diffVolumeUsage', () => {
  const limit = CLICKHOUSE_VOLUME_USAGE_LIMIT_PERCENT;

  it('says nothing while there is headroom', () => {
    expect(diffVolumeUsage(limit, { usedMb: 853, capacityMb: 50000 })).toBeNull();
  });

  it('reports once past the limit, and cannot fix it itself', () => {
    const change = diffVolumeUsage(limit, { usedMb: 45000, capacityMb: 50000 });
    expect(change).toMatchObject({ resource: 'volume-usage', blocked: true });
    expect(change?.summary).toContain('90.0% full');
  });

  it('explains that a full volume also blocks the next OTA restart', () => {
    // Not a nicety: xprem exits at boot when ClickHouse is unreachable, so a
    // disk alert is really an availability alert for updates.boardsesh.com.
    const change = diffVolumeUsage(limit, { usedMb: 49000, capacityMb: 50000 });
    expect(change?.detail).toMatch(/blocks the next OTA restart|exits at boot/);
  });

  it('treats an unavailable reading as unchecked, not as plenty of room', () => {
    expect(diffVolumeUsage(limit, null)).toBeNull();
  });

  it('does not divide by a zero capacity', () => {
    expect(diffVolumeUsage(limit, { usedMb: 10, capacityMb: 0 })).toBeNull();
  });

  it('is reached through buildPlan, not only in isolation', () => {
    const plan = buildPlan(
      desiredRailwayState,
      liveState({ clickhouseVolume: { usedMb: 49000, capacityMb: 50000 } }),
      PLAN_OPTIONS,
    );
    expect(plan.filter((change) => change.resource === 'volume-usage')).toHaveLength(1);
  });
});

describe('buildPlan', () => {
  it('keeps a skipped instance read distinct from a confirmed missing environment instance', () => {
    const skipped = buildPlan(desiredRailwayState, liveState({ instances: {} }), PLAN_OPTIONS);
    expect(skipped.filter((change) => change.resource === 'service-instance')).toEqual([]);
    const missing = buildPlan(
      desiredRailwayState,
      liveState({ instances: { [OTA_SERVICE_NAME]: null } }),
      PLAN_OPTIONS,
    );
    expect(missing.filter((change) => change.resource === 'service-instance')).toEqual([
      expect.objectContaining({ service: OTA_SERVICE_NAME, blocked: true }),
    ]);
  });

  it('skips the retention check entirely when ClickHouse was not reachable', () => {
    const plan = buildPlan(desiredRailwayState, liveState({ clickhouseTtl: null }), PLAN_OPTIONS);
    expect(plan.filter((change) => change.resource === 'clickhouse-ttl')).toEqual([]);
  });

  it('does not repeat variable drift for a service it already reported missing', () => {
    const live = liveState({ services: [], variables: {}, instances: {} });
    const plan = buildPlan(desiredRailwayState, live, PLAN_OPTIONS);
    expect(plan.filter((change) => change.resource === 'env-var')).toEqual([]);
    // One per asserted service: the two managed ones, OTA Postgres, the primary, and web.
    expect(plan.filter((change) => change.resource === 'service')).toHaveLength(5);
  });

  it('reports missing TTLs', () => {
    const plan = buildPlan(desiredRailwayState, liveState({ clickhouseTtl: {} }), PLAN_OPTIONS);
    // One per declared table, so this keeps counting whatever config.ts declares.
    expect(plan.filter((change) => change.resource === 'clickhouse-ttl')).toHaveLength(CLICKHOUSE_RETENTION.length);
  });

  it('covers every table xprem creates, so none grows unbounded unnoticed', () => {
    // The five tables in xprem's two ClickHouse migrations. A new one appearing
    // upstream should fail here rather than quietly accumulate forever.
    expect(CLICKHOUSE_RETENTION.map((table) => table.table).sort()).toEqual([
      'device_health_events',
      'observe_logs',
      'observe_metrics',
      'update_health_segment_snapshots',
      'update_health_snapshots',
    ]);
  });

  it('refuses a run that would change the ClickHouse and OTA images together', () => {
    // xprem exits at boot when ClickHouse is unreachable, so rolling both at once
    // can restart the OTA server while ClickHouse is down.
    const olderOta = `${OTA_IMAGE_REPOSITORY}:v3.0.5`;
    const olderClickHouse = 'clickhouse/clickhouse-server:24.1';
    const base = liveState();
    const live: LiveState = {
      ...base,
      instances: {
        ...base.instances,
        [OTA_SERVICE_NAME]: { ...convergedInstance(OTA), image: olderOta, runningImage: olderOta },
        [CLICKHOUSE_SERVICE_NAME]: {
          ...convergedInstance(CLICKHOUSE),
          image: olderClickHouse,
          runningImage: olderClickHouse,
        },
      },
    };
    const imageChanges = buildPlan(desiredRailwayState, live, { ...PLAN_OPTIONS, allowImageChange: true }).filter(
      (change) => change.resource === 'service-image',
    );

    expect(imageChanges.map((change) => change.service)).toEqual([OTA_SERVICE_NAME, CLICKHOUSE_SERVICE_NAME]);
    for (const change of imageChanges) {
      expect(change.blocked, change.service).toBe(true);
      expect(change.summary, change.service).toMatch(/separate PR/);
    }
  });

  it('refuses a ClickHouse image change in the same run as any OTA service write', () => {
    // A batch unwind could roll ClickHouse back and then restart the OTA server
    // while ClickHouse is not yet accepting connections.
    const olderClickHouse = 'clickhouse/clickhouse-server:24.1';
    const base = liveState();
    const live: LiveState = {
      ...base,
      variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })),
      instances: {
        ...base.instances,
        [OTA_SERVICE_NAME]: { ...convergedInstance(OTA), healthcheckTimeout: 300 },
        [CLICKHOUSE_SERVICE_NAME]: {
          ...convergedInstance(CLICKHOUSE),
          image: olderClickHouse,
          runningImage: olderClickHouse,
        },
      },
    };
    const plan = buildPlan(desiredRailwayState, live, { ...PLAN_OPTIONS, allowImageChange: true });
    const coupled = plan.filter(
      (change) =>
        (change.resource === 'service-image' && change.service === CLICKHOUSE_SERVICE_NAME) ||
        change.service === OTA_SERVICE_NAME ||
        change.target?.serviceName === OTA_SERVICE_NAME,
    );

    expect(coupled.map((change) => change.resource).sort((left, right) => left.localeCompare(right))).toEqual([
      'deploy-setting',
      'env-var',
      'service-image',
    ]);
    for (const change of coupled) {
      expect(change.blocked, change.summary).toBe(true);
      expect(change.summary).toMatch(/OTA service first/);
    }
  });

  it('refuses a run that would change the ClickHouse and OTA images together', () => {
    const base = liveState();
    const live: LiveState = {
      ...base,
      variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })),
      instances: {
        ...base.instances,
        [OTA_SERVICE_NAME]: {
          ...convergedInstance(OTA),
          image: `${OTA_IMAGE_REPOSITORY}:v3.0.5`,
          drainingSeconds: 0,
          customDomains: [],
          numReplicas: 2,
        },
        [CLICKHOUSE_SERVICE_NAME]: { ...convergedInstance(CLICKHOUSE), volumeMountPaths: [] },
      },
    };
    const plan = buildPlan(desiredRailwayState, live, PLAN_OPTIONS);
    const resources = plan.map((change) => change.resource);
    expect(resources).toContain('service-image');
    expect(resources).toContain('deploy-setting');
    expect(resources).toContain('domain');
    expect(resources).toContain('volume');
    expect(resources).toContain('scale');
    expect(resources).toContain('env-var');
    expect(JSON.stringify(plan)).not.toContain(WRONG_OWNED_VALUE);
  });
});

describe('inventory services', () => {
  it('are declared, so undeclaredServices reports a genuinely new service instead of the same three lines', () => {
    expect(undeclaredServices(desiredRailwayState, liveState())).toEqual([]);
  });

  it('reports a foreign service without proposing to remove it', () => {
    const live = liveState({ services: [...convergedServices(), { id: 'svc-new', name: 'boardsesh-experiment' }] });
    expect(undeclaredServices(desiredRailwayState, live)).toEqual(['boardsesh-experiment']);
    const plan = buildPlan(desiredRailwayState, live, PLAN_OPTIONS);
    expect(plan.some((change) => /boardsesh-experiment/.test(change.summary))).toBe(false);
  });

  it('are asserted about by no diff function, since nothing about them is ours', () => {
    // Even against a live state where their instances exist and hold nothing we declare.
    const base = liveState();
    const live: LiveState = {
      ...base,
      instances: {
        ...base.instances,
        ...Object.fromEntries(
          INVENTORY_SERVICES.map((service) => [
            service.name,
            { ...convergedInstance(service), image: 'ghcr.io/somebody/else:v1.0.0', volumeMountPaths: [] },
          ]),
        ),
      },
    };

    for (const service of INVENTORY_SERVICES) {
      expect(diffService(service, live)).toBeNull();
      expect(diffServiceImage(service, live, PLAN_OPTIONS)).toBeNull();
      expect(diffDeploySettings(service, live)).toEqual([]);
      expect(diffCustomDomains(service, live)).toEqual([]);
      expect(diffVolumeMount(service, live)).toBeNull();
      expect(diffScale(service, live)).toEqual([]);
      expect(diffServiceVars(service, live, PLAN_OPTIONS)).toEqual([]);
      expect(diffForbiddenVars(service, live)).toEqual([]);
    }

    expect(buildPlan(desiredRailwayState, live, PLAN_OPTIONS)).toEqual([]);
  });

  it('are not queried for their instance configuration either', () => {
    const read = servicesNeedingInstanceRead(desiredRailwayState);
    for (const service of INVENTORY_SERVICES) expect(read).not.toContain(service.name);
    expect(read).toEqual([
      OTA_SERVICE_NAME,
      CLICKHOUSE_SERVICE_NAME,
      OTA_POSTGRES_SERVICE_NAME,
      POSTGRES_PRIMARY_SERVICE_NAME,
      WEB_SERVICE_NAME,
    ]);
  });
});

describe('supplied values', () => {
  it('picks up RAILWAY_VAR_* and ignores everything else', () => {
    const supplied = collectSuppliedVars({
      RAILWAY_VAR_CLICKHOUSE_URL: 'clickhouse://u:p@h:9000/expo_observe',
      RAILWAY_TOKEN: 'not-a-variable-value',
      RAILWAY_VAR_EMPTY: '  ',
    });
    expect([...supplied.keys()]).toEqual(['CLICKHOUSE_URL']);
  });

  it('only keys variables the config declares as presence-only, never one this repo owns outright', () => {
    const supplied = new Map([
      ['CLICKHOUSE_URL', 'dsn'],
      ['BASE_URL', 'https://someone-elses-host.example'],
    ]);
    const keys = suppliedVarKeys(desiredRailwayState, supplied);
    expect([...keys]).toEqual([varKey(OTA_SERVICE_NAME, 'CLICKHOUSE_URL')]);
  });
});

describe('ttlFromEngineFull', () => {
  // Verbatim from ClickHouse 25.3 after the retention ALTER landed.
  const WITH_TTL =
    'MergeTree PARTITION BY toYYYYMM(timestamp) ORDER BY (app_id, update_id, timestamp) ' +
    'TTL toDateTime(timestamp) + toIntervalDay(90) SETTINGS index_granularity = 8192';

  it('reads the TTL clause out of engine_full', () => {
    expect(ttlFromEngineFull(WITH_TTL)).toBe('toDateTime(timestamp) + toIntervalDay(90)');
  });

  it('stops at SETTINGS rather than swallowing it', () => {
    expect(ttlFromEngineFull(WITH_TTL)).not.toContain('index_granularity');
  });

  it('handles a TTL that runs to the end of the string', () => {
    expect(ttlFromEngineFull('MergeTree ORDER BY x TTL toDateTime(ts) + toIntervalDay(7)')).toBe(
      'toDateTime(ts) + toIntervalDay(7)',
    );
  });

  it('reports a table with no TTL as empty, which the plan reads as "no retention"', () => {
    const noTtl = 'MergeTree PARTITION BY toYYYYMM(bucket) ORDER BY (app_id) SETTINGS index_granularity = 8192';
    expect(ttlFromEngineFull(noTtl)).toBe('');
    expect(diffTableRetention(CLICKHOUSE_RETENTION[0], ttlFromEngineFull(noTtl))?.summary).toContain('no TTL set');
  });
});

/** Swap globalThis.fetch for the duration of one call, recording what it was asked. */
async function withFetch<T>(
  stub: typeof globalThis.fetch,
  run: () => Promise<T>,
): Promise<{ result?: T; error?: Error; calls: { url: string; init?: RequestInit }[] }> {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // String() on a Request would give '[object Object]'; read the URL off it.
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return stub(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
  try {
    return { result: await run(), calls };
  } catch (error) {
    return { error: error as Error, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** Silence the logging main() and probeService() do, restoring it whatever happens. */
function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  console.warn = (...args: unknown[]) => void lines.push(args.join(' '));
  console.error = (...args: unknown[]) => void lines.push(args.join(' '));
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}

describe('fetchClickHouseTtl', () => {
  const ENGINE_WITH_TTL =
    'MergeTree ORDER BY (app_id) TTL toDateTime(timestamp) + toIntervalDay(90) SETTINGS index_granularity = 8192';

  const ok = (body: string) => (async () => new Response(body, { status: 200 })) as typeof globalThis.fetch;

  it('treats a missing DSN as "not checked" rather than "no drift"', async () => {
    expect(await fetchClickHouseTtl(undefined, 'expo_observe')).toBeNull();
  });

  it('reads the HTTP interface on 8123 when the DSN names the native port', async () => {
    const { calls } = await withFetch(ok(''), () =>
      fetchClickHouseTtl('clickhouse://u:p@ch.internal:9000/expo_observe', 'expo_observe'),
    );
    expect(calls[0].url).toBe('http://ch.internal:8123/');
  });

  it('keeps a non-default port, so a proxied endpoint still works', async () => {
    const { calls } = await withFetch(ok(''), () =>
      fetchClickHouseTtl('clickhouse://u:p@proxy.rlwy.net:22497/expo_observe', 'expo_observe'),
    );
    expect(calls[0].url).toBe('http://proxy.rlwy.net:22497/');
  });

  it('sends the DSN credentials as ClickHouse auth headers', async () => {
    const { calls } = await withFetch(ok(''), () =>
      fetchClickHouseTtl('clickhouse://someone:s3cret@ch.internal:9000/expo_observe', 'expo_observe'),
    );
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['X-ClickHouse-User']).toBe('someone');
    expect(headers['X-ClickHouse-Key']).toBe('s3cret');
  });

  it('parses the TTL out of each engine_full row', async () => {
    const body = `observe_metrics\t${ENGINE_WITH_TTL}\nobserve_logs\tMergeTree ORDER BY (app_id)\n`;
    const { result } = await withFetch(ok(body), () =>
      fetchClickHouseTtl('clickhouse://u:p@ch.internal:9000/expo_observe', 'expo_observe'),
    );
    expect(result).toEqual({
      observe_metrics: 'toDateTime(timestamp) + toIntervalDay(90)',
      observe_logs: '',
    });
  });

  it('surfaces an HTTP error instead of reporting no drift', async () => {
    const failing = (async () => new Response('boom', { status: 500 })) as typeof globalThis.fetch;
    const { error } = await withFetch(failing, () =>
      fetchClickHouseTtl('clickhouse://u:p@ch.internal:9000/expo_observe', 'expo_observe'),
    );
    expect(error?.message).toContain('500');
  });

  it('refuses a database name that is not a plain identifier', async () => {
    const { error, calls } = await withFetch(ok(''), () =>
      fetchClickHouseTtl('clickhouse://u:p@ch.internal:9000/x', "expo_observe'; DROP TABLE x --"),
    );
    expect(error?.message).toContain('plain identifier');
    expect(calls).toHaveLength(0);
  });
});

describe('fetchVolumes', () => {
  const VOLUMES_RESPONSE = {
    project: {
      volumes: {
        edges: [
          {
            node: {
              name: CLICKHOUSE_VOLUME_NAME,
              volumeInstances: {
                edges: [
                  {
                    node: {
                      sizeMB: 50000,
                      currentSizeMB: 853,
                      mountPath: CLICKHOUSE_VOLUME_MOUNT_PATH,
                      serviceId: liveServiceId(CLICKHOUSE_SERVICE_NAME),
                      environmentId: 'env-prod',
                    },
                  },
                ],
              },
            },
          },
          {
            node: {
              name: 'ota-postgres-data',
              volumeInstances: {
                edges: [
                  {
                    node: {
                      sizeMB: 20000,
                      currentSizeMB: 400,
                      mountPath: OTA_POSTGRES_VOLUME_MOUNT_PATH,
                      serviceId: liveServiceId(OTA_POSTGRES_SERVICE_NAME),
                      environmentId: 'env-prod',
                    },
                  },
                  // An unattached volume instance: no service to mount it on.
                  {
                    node: {
                      sizeMB: 5000,
                      currentSizeMB: 0,
                      mountPath: '/detached',
                      serviceId: null,
                      environmentId: 'env-prod',
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    },
  };

  const stub = (async () =>
    new Response(JSON.stringify({ data: VOLUMES_RESPONSE }), { status: 200 })) as typeof globalThis.fetch;

  it('reads the ClickHouse utilisation Railway can answer even when ClickHouse cannot', async () => {
    resetAuthScheme();
    const { result } = await withFetch(stub, () =>
      fetchVolumes('token', 'project', 'env-prod', CLICKHOUSE_VOLUME_NAME),
    );
    expect(result?.clickhouse).toEqual({ usedMb: 853, capacityMb: 50000 });
  });

  it('maps every mount to its service, which is what catches a volume that came detached', async () => {
    resetAuthScheme();
    const { result } = await withFetch(stub, () =>
      fetchVolumes('token', 'project', 'env-prod', CLICKHOUSE_VOLUME_NAME),
    );
    expect(result?.mountsByService.get(liveServiceId(CLICKHOUSE_SERVICE_NAME))).toEqual([CLICKHOUSE_VOLUME_MOUNT_PATH]);
    expect(result?.mountsByService.get(liveServiceId(OTA_POSTGRES_SERVICE_NAME))).toEqual([
      OTA_POSTGRES_VOLUME_MOUNT_PATH,
    ]);
  });

  it('skips a volume instance attached to no service instead of crashing on it', async () => {
    resetAuthScheme();
    const { result, error } = await withFetch(stub, () =>
      fetchVolumes('token', 'project', 'env-prod', CLICKHOUSE_VOLUME_NAME),
    );
    expect(error).toBeUndefined();
    expect([...(result?.mountsByService.values() ?? [])].flat()).not.toContain('/detached');
  });

  it('reports no reading rather than a wrong one when the named volume is absent', async () => {
    resetAuthScheme();
    const { result } = await withFetch(stub, () => fetchVolumes('token', 'project', 'env-prod', 'some-other-volume'));
    expect(result?.clickhouse).toBeNull();
  });

  it('ignores volume instances from another environment in the project', async () => {
    const response = structuredClone(VOLUMES_RESPONSE);
    response.project.volumes.edges[0].node.volumeInstances.edges.push({
      node: {
        sizeMB: 90000,
        currentSizeMB: 80000,
        mountPath: '/wrong-environment',
        serviceId: liveServiceId(CLICKHOUSE_SERVICE_NAME),
        environmentId: 'env-preview',
      },
    });
    const environmentStub = (async () =>
      new Response(JSON.stringify({ data: response }), { status: 200 })) as typeof globalThis.fetch;

    resetAuthScheme();
    const { result } = await withFetch(environmentStub, () =>
      fetchVolumes('token', 'project', 'env-prod', CLICKHOUSE_VOLUME_NAME),
    );
    expect(result?.clickhouse).toEqual({ usedMb: 853, capacityMb: 50000 });
    expect(result?.mountsByService.get(liveServiceId(CLICKHOUSE_SERVICE_NAME))).not.toContain('/wrong-environment');
  });
});

describe('fetchUpdateInputFields', () => {
  const fieldsResponse = (names: string[]) =>
    (async () =>
      new Response(JSON.stringify({ data: { __type: { inputFields: names.map((name) => ({ name })) } } }), {
        status: 200,
      })) as typeof globalThis.fetch;

  it('reads the schema itself, because Railway’s published field list omits source and drainingSeconds', async () => {
    const { result } = await withFetch(fieldsResponse(['source', 'drainingSeconds']), () => fetchUpdateInputFields());
    expect(result?.has('source')).toBe(true);
    expect(result?.has('drainingSeconds')).toBe(true);
  });

  it('sends no token, since introspection is open and the token has no business here', async () => {
    const { calls } = await withFetch(fieldsResponse(['source']), () => fetchUpdateInputFields());
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Project-Access-Token']).toBeUndefined();
  });

  it('bounds the direct introspection fetch with the Railway request timeout', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      const { calls } = await withFetch(fieldsResponse(['source']), () => fetchUpdateInputFields());
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(calls[0].init?.signal).toBe(controller.signal);
    } finally {
      timeout.mockRestore();
    }
  });

  it('throws rather than guessing when the type has gone', async () => {
    const missing = (async () =>
      new Response(JSON.stringify({ data: { __type: null } }), { status: 200 })) as typeof globalThis.fetch;
    const { error } = await withFetch(missing, () => fetchUpdateInputFields());
    expect(error?.message).toMatch(/no ServiceInstanceUpdateInput/);
  });

  it('throws on a non-200 rather than treating a proxy error page as an empty schema', async () => {
    const failing = (async () => new Response('gateway', { status: 502 })) as typeof globalThis.fetch;
    const { error } = await withFetch(failing, () => fetchUpdateInputFields());
    expect(error?.message).toMatch(/502/);
  });
});

describe('canRollBack', () => {
  const projectTokenResponse = (projectToken: { projectId: string } | null) =>
    (async () => new Response(JSON.stringify({ data: { projectToken } }), { status: 200 })) as typeof globalThis.fetch;

  it('returns false for an account token or a token scoped to another project', async () => {
    resetAuthScheme();
    const account = await withFetch(projectTokenResponse(null), () => canRollBack('account-token', 'project'));
    expect(account.result).toBe(false);

    resetAuthScheme();
    const crossProject = await withFetch(projectTokenResponse({ projectId: 'other-project' }), () =>
      canRollBack('project-token', 'project'),
    );
    expect(crossProject.result).toBe(false);
  });

  it('returns false when Railway rejects both supported authentication schemes', async () => {
    resetAuthScheme();
    const denied = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Not Authorized' }] }), {
        status: 200,
      })) as typeof globalThis.fetch;
    const { result, calls } = await withFetch(denied, () => canRollBack('denied-token', 'project'));
    expect(result).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('propagates transport and malformed-response failures instead of calling them a scope mismatch', async () => {
    resetAuthScheme();
    const transport = await withFetch(
      (async () => {
        throw new Error('socket reset');
      }) as typeof globalThis.fetch,
      () => canRollBack('token', 'project'),
    );
    expect(transport.error?.message).toMatch(/Could not verify Railway rollback capability: socket reset/);

    resetAuthScheme();
    const malformed = await withFetch(
      (async () => new Response('not json', { status: 200 })) as typeof globalThis.fetch,
      () => canRollBack('token', 'project'),
    );
    expect(malformed.error?.message).toMatch(/Could not verify Railway rollback capability.*not json/s);
  });

  it('propagates GraphQL failures that are not the unsupported project-token field', async () => {
    resetAuthScheme();
    const internalFailure = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Internal service failure' }] }), {
        status: 200,
      })) as typeof globalThis.fetch;
    const { error } = await withFetch(internalFailure, () => canRollBack('token', 'project'));
    expect(error?.message).toMatch(/Could not verify Railway rollback capability.*Internal service failure/s);
  });

  it('returns false when Railway does not expose the project-token scope field', async () => {
    resetAuthScheme();
    const unsupported = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Cannot query field "projectToken" on type "Query".' }] }), {
        status: 200,
      })) as typeof globalThis.fetch;
    const { result } = await withFetch(unsupported, () => canRollBack('token', 'project'));
    expect(result).toBe(false);
  });
});

describe('probeService', () => {
  it('turns "deployed" into "working" by asking the server for each declared path', async () => {
    const captured = captureConsole();
    const seen: string[] = [];
    const stub = (async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response('ok', { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const { error } = await withFetch(stub, () => probeService({ baseUrl: OTA_BASE_URL, paths: ['/hc', '/ready'] }));
      expect(error).toBeUndefined();
      expect(seen).toEqual([`${OTA_BASE_URL}/hc`, `${OTA_BASE_URL}/ready`]);
    } finally {
      captured.restore();
    }
  });

  it('fails the probe on a bad status, which is what triggers the rollback', async () => {
    const captured = captureConsole();
    let attempts = 0;
    const sleeps: number[] = [];
    const stub = (async () => {
      attempts += 1;
      return new Response('nope', { status: 503 });
    }) as typeof globalThis.fetch;
    try {
      const { error } = await withFetch(stub, () =>
        probeService({ baseUrl: OTA_BASE_URL, paths: ['/ready'] }, async (milliseconds) => {
          sleeps.push(milliseconds);
        }),
      );
      expect(error?.message).toMatch(/probe failed.*503/);
      expect(attempts).toBe(3);
      expect(sleeps).toEqual([5_000, 5_000]);
    } finally {
      captured.restore();
    }
  });
});

describe('waitForDeployment', () => {
  /** Answer the deployment poll with the given statuses in order; the last one repeats. */
  function deploymentStub(
    statuses: string[],
    meta: unknown = {},
  ): { fetch: typeof globalThis.fetch; polls: () => number } {
    let polls = 0;
    const fetchStub = (async () => {
      const status = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      return new Response(JSON.stringify({ data: { deployment: { id: 'dep-new', status, meta } } }), { status: 200 });
    }) as typeof globalThis.fetch;
    return { fetch: fetchStub, polls: () => polls };
  }

  const noSleep = async () => {};

  it('needs three consecutive SUCCESS polls, because one has been seen to be a lie', async () => {
    resetAuthScheme();
    const stub = deploymentStub(['SUCCESS']);
    let sleeps = 0;
    const { error } = await withFetch(stub.fetch, () =>
      waitForDeployment('token', 'dep-new', null, async () => {
        sleeps += 1;
      }),
    );
    expect(error).toBeUndefined();
    expect(stub.polls()).toBe(DEPLOY_SUCCESS_CONFIRMATIONS);
    expect(sleeps).toBe(DEPLOY_SUCCESS_CONFIRMATIONS - 1);
  });

  it('keeps waiting through the in-flight statuses instead of calling them failures', async () => {
    resetAuthScheme();
    const stub = deploymentStub(['QUEUED', 'BUILDING', 'DEPLOYING', 'SUCCESS']);
    const { error } = await withFetch(stub.fetch, () => waitForDeployment('token', 'dep-new', null, noSleep));
    expect(error).toBeUndefined();
    expect(stub.polls()).toBe(3 + DEPLOY_SUCCESS_CONFIRMATIONS);
  });

  it('restarts the count when a SUCCESS turns out not to have stuck', async () => {
    resetAuthScheme();
    const stub = deploymentStub(['SUCCESS', 'SUCCESS', 'DEPLOYING', 'FAILED']);
    const { error } = await withFetch(stub.fetch, () => waitForDeployment('token', 'dep-new', null, noSleep));
    expect(error?.message).toMatch(/finished as FAILED/);
  });

  it('throws on a deployment that failed or crashed', async () => {
    resetAuthScheme();
    const failed = await withFetch(deploymentStub(['FAILED']).fetch, () =>
      waitForDeployment('token', 'dep-new', null, noSleep),
    );
    expect(failed.error?.message).toMatch(/finished as FAILED/);

    resetAuthScheme();
    const crashed = await withFetch(deploymentStub(['CRASHED']).fetch, () =>
      waitForDeployment('token', 'dep-new', null, noSleep),
    );
    expect(crashed.error?.message).toMatch(/finished as CRASHED/);
  });

  it('says so distinctly when a deployment is parked waiting for approval', async () => {
    resetAuthScheme();
    const { error } = await withFetch(deploymentStub(['NEEDS_APPROVAL']).fetch, () =>
      waitForDeployment('token', 'dep-new', null, noSleep),
    );
    expect(error?.message).toMatch(/waiting for approval/);
    expect(error?.message).not.toMatch(/finished as/);
  });

  it.each(['CANCELED', 'CANCELLED'])('treats %s as superseded instead of a failed deployment', async (status) => {
    resetAuthScheme();
    const { error } = await withFetch(deploymentStub([status]).fetch, () =>
      waitForDeployment('token', 'dep-new', null, noSleep),
    );
    expect(error?.name).toBe('DeploymentSupersededError');
    expect(error?.message).toMatch(/newer deployment replaced it/);
  });

  it('retries transient deployment reads and still requires three clean successes', async () => {
    resetAuthScheme();
    let calls = 0;
    const transient = (async () => {
      calls += 1;
      if (calls === 1) return new Response('temporary gateway failure', { status: 502 });
      return new Response(JSON.stringify({ data: { deployment: { id: 'dep-new', status: 'SUCCESS', meta: {} } } }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;
    const { error } = await withFetch(transient, () => waitForDeployment('token', 'dep-new', null, noSleep));
    expect(error).toBeUndefined();
    expect(calls).toBe(1 + DEPLOY_SUCCESS_CONFIRMATIONS);
  });

  it('restarts success confirmations after a transient read failure', async () => {
    resetAuthScheme();
    let calls = 0;
    const interruptedSuccess = (async () => {
      calls += 1;
      if (calls === 2) return new Response('temporary gateway failure', { status: 502 });
      return new Response(JSON.stringify({ data: { deployment: { id: 'dep-new', status: 'SUCCESS', meta: {} } } }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    const { error } = await withFetch(interruptedSuccess, () => waitForDeployment('token', 'dep-new', null, noSleep));
    expect(error).toBeUndefined();
    expect(calls).toBe(2 + DEPLOY_SUCCESS_CONFIRMATIONS);
  });

  it('fails after three consecutive deployment read errors', async () => {
    resetAuthScheme();
    let calls = 0;
    const unavailable = (async () => {
      calls += 1;
      return new Response('temporary gateway failure', { status: 502 });
    }) as typeof globalThis.fetch;
    const { error } = await withFetch(unavailable, () => waitForDeployment('token', 'dep-new', null, noSleep));
    expect(error?.message).toMatch(/HTTP 502/);
    expect(calls).toBe(3);
  });

  it('retries a malformed deployment response instead of rolling back immediately', async () => {
    resetAuthScheme();
    let calls = 0;
    const malformedOnce = (async () => {
      calls += 1;
      const deployment = calls === 1 ? null : { id: 'dep-new', status: 'SUCCESS', meta: {} };
      return new Response(JSON.stringify({ data: { deployment } }), { status: 200 });
    }) as typeof globalThis.fetch;
    const { error } = await withFetch(malformedOnce, () => waitForDeployment('token', 'dep-new', null, noSleep));
    expect(error).toBeUndefined();
    expect(calls).toBe(4);
  });

  it('refuses to adopt a deployment somebody else raced in on top of ours', async () => {
    resetAuthScheme();
    const stub = deploymentStub(['SUCCESS'], { image: `${OTA_IMAGE_REPOSITORY}:v3.0.5` });
    const { error } = await withFetch(stub.fetch, () => waitForDeployment('token', 'dep-new', OTA_IMAGE, noSleep));
    expect(error?.message).toMatch(/another deploy raced this one/);
    expect(error?.message).toMatch(/Not rolling back/);
  });

  it('refuses to call a SUCCESS healthy when it omits the image it should be running', async () => {
    // Without meta.image the raced-image check has nothing to compare, so three
    // such readings would otherwise confirm a rollout nobody could verify.
    resetAuthScheme();
    const stub = deploymentStub(['SUCCESS'], {});
    const { error } = await withFetch(stub.fetch, () => waitForDeployment('token', 'dep-new', OTA_IMAGE, noSleep));
    expect(error?.message).toMatch(/meta\.image/);
    expect(stub.polls()).toBe(3);
  });

  it('gives up rather than polling a stuck deployment forever', async () => {
    resetAuthScheme();
    const stub = deploymentStub(['DEPLOYING']);
    const { error } = await withFetch(stub.fetch, () => waitForDeployment('token', 'dep-new', null, noSleep));
    expect(error?.message).toMatch(/did not settle within \d+ polls/);
    expect(stub.polls()).toBeGreaterThan(1);
  });

  it('counts a queued or approval-gated deployment as in flight', () => {
    // The same set fences the mutation path: a service that is not quiet is not touched.
    expect(ACTIVE_DEPLOYMENT_STATUSES.has('QUEUED')).toBe(true);
    expect(ACTIVE_DEPLOYMENT_STATUSES.has('NEEDS_APPROVAL')).toBe(true);
    expect(ACTIVE_DEPLOYMENT_STATUSES.has('SUCCESS')).toBe(false);
  });
});

describe('previousConfigurationInput', () => {
  it('attempts every rollback in reverse even after one fails', async () => {
    const attempted: string[] = [];
    const allSucceeded = await rollbackAppliedDeployments(['first', 'second'], async (service) => {
      attempted.push(service);
      return service !== 'second';
    });

    expect(attempted).toEqual(['second', 'first']);
    expect(allSucceeded).toBe(false);
  });

  it('restores only fields changed by this run and preserves nulls', () => {
    const previous = convergedInstance(OTA);
    if (!previous) throw new Error('OTA fixture must have an instance');

    expect(
      previousConfigurationInput(
        {
          serviceName: OTA_SERVICE_NAME,
          serviceId: OTA_SERVICE_ID,
          deployFields: { healthcheckPath: '/new', restartPolicyMaxRetries: 9 },
        },
        { ...previous, healthcheckPath: null, restartPolicyMaxRetries: 2 },
      ),
    ).toEqual({ healthcheckPath: null, restartPolicyMaxRetries: 2 });
  });

  it('restores the previous image only when this run changed it', () => {
    const previous = convergedInstance(OTA);
    if (!previous) throw new Error('OTA fixture must have an instance');

    expect(
      previousConfigurationInput(
        {
          serviceName: OTA_SERVICE_NAME,
          serviceId: OTA_SERVICE_ID,
          deployFields: {},
          image: `${OTA_IMAGE_REPOSITORY}:v3.2.0`,
        },
        { ...previous, image: null },
      ),
    ).toEqual({ source: { image: null } });
  });

  it('sends prior deploy settings, including null, after rollback', async () => {
    resetAuthScheme();
    const previous = convergedInstance(OTA);
    if (!previous) throw new Error('OTA fixture must have an instance');
    const api = (async () =>
      new Response(JSON.stringify({ data: { serviceInstanceUpdate: true } }), {
        status: 200,
      })) as typeof globalThis.fetch;
    const captured = captureConsole();

    try {
      const { error, calls } = await withFetch(api, () =>
        restoreConfiguration(
          'token',
          'env-prod',
          {
            serviceName: OTA_SERVICE_NAME,
            serviceId: OTA_SERVICE_ID,
            deployFields: { healthcheckPath: '/new', healthcheckTimeout: 100 },
          },
          { ...previous, healthcheckPath: null, healthcheckTimeout: 300 },
        ),
      );
      expect(error).toBeUndefined();
      expect(calls).toHaveLength(1);
      const rawBody = calls[0].init?.body;
      if (typeof rawBody !== 'string') throw new Error('Expected a JSON request body');
      const body = JSON.parse(rawBody) as { variables: Record<string, unknown> };
      expect(body.variables).toEqual({
        environmentId: 'env-prod',
        serviceId: OTA_SERVICE_ID,
        input: { healthcheckPath: null, healthcheckTimeout: 300 },
      });
    } finally {
      captured.restore();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * The I/O layer, against a stubbed Railway API.
 * ------------------------------------------------------------------------- */

interface RecordedCall {
  query: string;
  variables: Record<string, unknown>;
  headers: Record<string, string>;
}

/** One service instance as the Railway GraphQL API shapes it. */
interface InstanceResponse {
  source: { image: string | null } | null;
  healthcheckPath: string | null;
  healthcheckTimeout: number | null;
  restartPolicyType: string | null;
  restartPolicyMaxRetries: number | null;
  drainingSeconds: number | null;
  region: string | null;
  numReplicas: number | null;
  domains: { customDomains: { domain: string; targetPort: number | null }[] } | null;
  latestDeployment: { id: string; status: string; createdAt: string; meta: unknown; canRollback: boolean } | null;
  activeDeployments: { id: string; status: string; meta?: unknown; canRollback?: boolean }[];
}

interface StubOptions {
  /** Live variables per service name. Defaults to the fully converged set. */
  variables?: Record<string, Record<string, string>>;
  /** Per-service overrides on top of the converged instance shape. */
  instances?: Record<string, Partial<InstanceResponse>>;
  /** Project services absent from the selected environment. */
  missingInstances?: string[];
  /** What the ServiceInstanceUpdateInput introspection reports. */
  updateInputFields?: string[];
  /** Statuses the deployment poll returns in order; the last one repeats. */
  deploymentStatuses?: string[];
  /**
   * `meta` on the polled deployment. Defaults to the image the deployed service is
   * configured for at poll time, which is what a healthy Railway deployment reports.
   */
  deploymentMeta?: unknown;
  /** HTTP statuses returned by service probes; the last one repeats. */
  probeStatuses?: number[];
  /** Extra live services the project holds that config.ts does not declare. */
  extraServices?: { id: string; name: string }[];
  /**
   * Whether the token answers `projectToken`, i.e. whether it can drive a rollback.
   * Defaults to true; set false to stand in for an account token.
   */
  projectScoped?: boolean;
  /** The project the token is scoped to. Defaults to the one under test. */
  tokenProjectId?: string;
}

const NEW_DEPLOYMENT_ID = 'dep-rolled-by-this-tool';

/** Every input field the apply path can write. */
const DEFAULT_UPDATE_INPUT_FIELDS = [
  'source',
  'healthcheckPath',
  'healthcheckTimeout',
  'restartPolicyType',
  'restartPolicyMaxRetries',
  'drainingSeconds',
];

function convergedInstanceResponse(service: ServiceDesired): InstanceResponse {
  return {
    source: service.image ? { image: service.image } : null,
    healthcheckPath: service.deploy?.healthcheckPath ?? null,
    healthcheckTimeout: service.deploy?.healthcheckTimeout ?? null,
    restartPolicyType: service.deploy?.restartPolicyType ?? null,
    restartPolicyMaxRetries: service.deploy?.restartPolicyMaxRetries ?? null,
    drainingSeconds: service.deploy?.drainingSeconds ?? null,
    region: service.expectedScale?.region ?? null,
    numReplicas: service.expectedScale?.numReplicas ?? null,
    domains: { customDomains: (service.domains ?? []).map((domain) => ({ ...domain })) },
    latestDeployment: {
      id: 'dep-previous',
      status: 'SUCCESS',
      createdAt: '2026-09-01T00:00:00.000Z',
      meta: { image: service.image ?? null },
      canRollback: true,
    },
    activeDeployments: [
      { id: 'dep-previous', status: 'SUCCESS', meta: { image: service.image ?? null }, canRollback: true },
    ],
  };
}

/**
 * A Railway API that answers every operation this tool sends, starting from a
 * project that already matches config.ts. Overrides introduce exactly the drift a
 * test is about.
 */
function railwayStub(options: StubOptions = {}): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
  probeCalls: () => number;
} {
  const calls: RecordedCall[] = [];
  const variables = options.variables ?? convergedVariables();
  const statuses = options.deploymentStatuses ?? ['SUCCESS'];
  let polls = 0;
  let probeCalls = 0;

  const graphql = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

  const instanceFor = (name: string): InstanceResponse => {
    const converged = convergedInstanceResponse(declaredService(name));
    const override = options.instances?.[name] ?? {};
    // An override that only moves the configured image describes a service that
    // was deployed from that image, so its serving deployment reports it too.
    // A test that wants configured and running to disagree says so explicitly.
    const servedImage = override.source === undefined ? undefined : (override.source?.image ?? null);
    const deployments =
      servedImage === undefined
        ? {}
        : {
            latestDeployment: converged.latestDeployment && {
              ...converged.latestDeployment,
              meta: { image: servedImage },
            },
            activeDeployments: converged.activeDeployments.map((deployment) => ({
              ...deployment,
              meta: { image: servedImage },
            })),
          };
    return { ...converged, ...deployments, ...override };
  };

  // What each service is configured for, as the tool's own writes move it.
  const configuredImages = new Map<string, string | null>(
    desiredRailwayState.services.map((service) => [service.name, instanceFor(service.name).source?.image ?? null]),
  );
  let lastDeployedService: string | undefined;

  const volumeEdges = desiredRailwayState.services.flatMap((service) =>
    service.volume
      ? [
          {
            node: {
              name: service.volume.name ?? `${service.name}-volume`,
              volumeInstances: {
                edges: [
                  {
                    node: {
                      sizeMB: 50000,
                      currentSizeMB: 853,
                      mountPath: service.volume.mountPath,
                      serviceId: liveServiceId(service.name),
                      environmentId: 'env-prod',
                    },
                  },
                ],
              },
            },
          },
        ]
      : [],
  );

  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Anything that is not the GraphQL endpoint is a post-deploy probe of the OTA server.
    if (!url.startsWith(RAILWAY_API)) {
      const probeStatuses = options.probeStatuses ?? [200];
      const status = probeStatuses[Math.min(probeCalls, probeStatuses.length - 1)];
      probeCalls += 1;
      return new Response(status === 200 ? 'ok' : 'nope', { status });
    }

    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(rawBody) as { query: string; variables?: Record<string, unknown> };
    calls.push({
      query: body.query,
      variables: body.variables ?? {},
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
    const requestedServiceId = body.variables?.serviceId;
    const serviceName = typeof requestedServiceId === 'string' ? serviceNameById(requestedServiceId) : undefined;

    if (body.query.includes('__type(')) {
      const fields = options.updateInputFields ?? DEFAULT_UPDATE_INPUT_FIELDS;
      return graphql({ __type: { inputFields: fields.map((name) => ({ name })) } });
    }
    if (body.query.includes('variableUpsert')) return graphql({ variableUpsert: true });
    if (body.query.includes('serviceInstanceUpdate(')) {
      const writtenSource = (body.variables?.input as { source?: { image?: string | null } } | undefined)?.source;
      if (serviceName && writtenSource) configuredImages.set(serviceName, writtenSource.image ?? null);
      return graphql({ serviceInstanceUpdate: true });
    }
    if (body.query.includes('projectToken')) {
      // An image change is refused unless the token can also drive the rollback.
      if (options.projectScoped === false) return graphql({ projectToken: null });
      return graphql({
        projectToken: { projectId: options.tokenProjectId ?? 'test-project', environmentId: 'env-prod' },
      });
    }
    if (body.query.includes('serviceInstanceDeployV2(')) {
      lastDeployedService = serviceName;
      return graphql({ serviceInstanceDeployV2: NEW_DEPLOYMENT_ID });
    }
    if (body.query.includes('deployment(id:')) {
      const status = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      const configuredImage = lastDeployedService ? configuredImages.get(lastDeployedService) : null;
      const defaultMeta = configuredImage ? { image: configuredImage } : {};
      return graphql({ deployment: { id: NEW_DEPLOYMENT_ID, status, meta: options.deploymentMeta ?? defaultMeta } });
    }
    if (body.query.includes('serviceInstance(')) {
      return graphql({
        serviceInstance:
          serviceName && !options.missingInstances?.includes(serviceName) ? instanceFor(serviceName) : null,
      });
    }
    if (body.query.includes('volumes {')) return graphql({ project: { volumes: { edges: volumeEdges } } });
    if (body.query.includes('variables(')) {
      return graphql({ variables: serviceName ? (variables[serviceName] ?? {}) : {} });
    }

    return graphql({
      project: {
        name: 'boardsesh-ota',
        environments: { edges: [{ node: { id: 'env-prod', name: desiredRailwayState.environmentName } }] },
        services: {
          edges: [...convergedServices(), ...(options.extraServices ?? [])].map((service) => ({ node: service })),
        },
      },
    });
  }) as typeof globalThis.fetch;

  return { fetch: fetchStub, calls, probeCalls: () => probeCalls };
}

interface RunResult {
  code: number | null;
  error: Error | null;
  output: string;
  calls: RecordedCall[];
}

/** Requests of one kind, in the order the tool sent them. */
function callsMatching(calls: RecordedCall[], needle: string): RecordedCall[] {
  return calls.filter((call) => call.query.includes(needle));
}

async function runCli(
  argv: string[],
  stub: { fetch: typeof globalThis.fetch; calls: RecordedCall[] },
  env: Record<string, string> = {},
  dependencies: Parameters<typeof main>[1] = {},
): Promise<RunResult> {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const captured = captureConsole();

  globalThis.fetch = stub.fetch;
  // A stray RAILWAY_VAR_* or CLICKHOUSE_URL in the developer's own shell must not
  // change what these tests exercise.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('RAILWAY_VAR_')) delete process.env[key];
  }
  delete process.env.CLICKHOUSE_URL;
  process.env.RAILWAY_TOKEN = 'test-token';
  process.env.RAILWAY_PROJECT_ID = 'test-project';
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  try {
    const code = await main(argv, dependencies);
    return { code, error: null, output: captured.lines.join('\n'), calls: stub.calls };
  } catch (error) {
    return { code: null, error: error as Error, output: captured.lines.join('\n'), calls: stub.calls };
  } finally {
    captured.restore();
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
}

describe('serving deployment identity', () => {
  it.each(['FAILED', 'CANCELED', 'CANCELLED'])(
    'reports the serving image when the newest attempt is %s',
    async (status) => {
      for (const argv of [[], ['--apply', '--allow-image-change', '--no-wait']]) {
        const olderImage = `${OTA_IMAGE_REPOSITORY}:v3.0.5`;
        const stub = railwayStub({
          variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })),
          instances: {
            [OTA_SERVICE_NAME]: {
              latestDeployment: {
                id: 'failed-latest',
                status,
                createdAt: '2026-09-21T00:00:00Z',
                meta: { image: OTA_IMAGE },
                canRollback: true,
              },
              activeDeployments: [
                { id: 'serving-older', status: 'SUCCESS', meta: { image: olderImage }, canRollback: true },
              ],
            },
          },
        });
        const { code, output, calls, error } = await runCli(argv, stub);
        expect(error).toBeNull();
        expect(code).toBe(1);
        expect(output).toContain(`running ${olderImage}`);
        expect(output).not.toContain('In sync');
        expect(calls.filter((call) => /\bmutation\b/.test(call.query))).toEqual([]);
      }
    },
  );

  it.each([
    ['missing', []],
    ['failed only', [{ id: 'failed', status: 'FAILED', meta: { image: OTA_IMAGE }, canRollback: true }]],
    ['missing image', [{ id: 'unknown-image', status: 'SUCCESS', meta: {}, canRollback: true }]],
    [
      'ambiguous',
      [
        { id: 'first', status: 'SUCCESS', meta: { image: OTA_IMAGE }, canRollback: true },
        { id: 'second', status: 'SUCCESS', meta: { image: OTA_IMAGE }, canRollback: true },
      ],
    ],
  ] as const)('refuses image-dependent writes when the serving deployment is %s', async (_label, deployments) => {
    const stub = railwayStub({
      variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })),
      instances: { [OTA_SERVICE_NAME]: { activeDeployments: [...deployments] } },
    });
    const { code, output, calls, error } = await runCli(['--apply', '--allow-image-change', '--no-wait'], stub);
    expect(error).toBeNull();
    expect(code).toBe(1);
    expect(output).toContain('serving deployment');
    expect(output).not.toContain('In sync');
    expect(calls.filter((call) => /\bmutation\b/.test(call.query))).toEqual([]);
  });

  it.each([true, false])('uses only the active deployment rollback capability (%s)', async (canRollback) => {
    const olderImage = `${OTA_IMAGE_REPOSITORY}:v3.0.5`;
    const stub = railwayStub({
      instances: {
        [OTA_SERVICE_NAME]: {
          source: { image: olderImage },
          latestDeployment: {
            id: 'failed-latest',
            status: 'FAILED',
            createdAt: '2026-09-21T00:00:00Z',
            meta: { image: 'failed-image' },
            canRollback: true,
          },
          activeDeployments: [{ id: 'serving-older', status: 'SUCCESS', meta: { image: olderImage }, canRollback }],
        },
      },
      deploymentStatuses: ['FAILED'],
    });
    const targets: string[] = [];
    const { code, output, calls, error } = await runCli(
      ['--apply', '--allow-image-change'],
      stub,
      {},
      {
        sleep: async () => {},
        rollbackDeployment: async ({ targetDeploymentId }) => {
          targets.push(targetDeploymentId);
          return { deploymentId: 'rollback-result', image: olderImage };
        },
      },
    );
    expect(error).toBeNull();
    expect(code).toBe(1);
    expect(targets).toEqual(canRollback ? ['serving-older'] : []);
    expect(targets).not.toContain('failed-latest');
    if (canRollback) {
      expect(callsMatching(calls, 'serviceInstanceUpdate(').at(-1)?.variables.input).toEqual({
        source: { image: olderImage },
      });
    } else {
      expect(output).toContain('No rollback target');
    }
  });
});

describe('main (dry run)', () => {
  it.each([CLICKHOUSE_SERVICE_NAME, OTA_POSTGRES_SERVICE_NAME])(
    'reports missing production instance %s and never creates it, even with --apply',
    async (serviceName) => {
      for (const argv of [[], ['--apply']]) {
        const { code, output, calls, error } = await runCli(argv, railwayStub({ missingInstances: [serviceName] }));
        expect(error).toBeNull();
        expect(code).toBe(1);
        expect(output).toContain(serviceName);
        expect(output).toContain('production');
        expect(output).toContain('instance');
        expect(output).not.toContain('In sync');
        expect(calls.filter((call) => /\bmutation\b/.test(call.query))).toEqual([]);
      }
    },
  );

  it('does not write variables or deploy a managed service whose environment instance is missing', async () => {
    const stub = railwayStub({
      missingInstances: [OTA_SERVICE_NAME],
      variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })),
    });
    const { code, calls, error } = await runCli(['--apply', '--allow-image-change', '--no-wait'], stub);
    expect(error).toBeNull();
    expect(code).toBe(1);
    expect(calls.filter((call) => /\bmutation\b/.test(call.query))).toEqual([]);
  });

  it('exits 0 and reports in-sync when the project matches config.ts', async () => {
    const { code, output, error } = await runCli([], railwayStub());
    expect(error).toBeNull();
    expect(code).toBe(0);
    expect(output).toContain('In sync');
  });

  it('exits non-zero on drift so CI can gate on it, and writes nothing', async () => {
    const stub = railwayStub({ variables: variablesWithOta(otaVariables({ CLICKHOUSE_URL: null })) });
    const { code, output, calls } = await runCli([], stub);
    expect(code).toBe(1);
    expect(output).toContain('CLICKHOUSE_URL is absent');
    expect(output).toContain('Dry-run');
    expect(callsMatching(calls, 'variableUpsert')).toHaveLength(0);
    expect(callsMatching(calls, 'serviceInstanceUpdate(')).toHaveLength(0);
    expect(callsMatching(calls, 'serviceInstanceDeployV2(')).toHaveLength(0);
  });

  it('does not even ask the schema what it could write, since it is not going to write', async () => {
    const stub = railwayStub({ variables: variablesWithOta(otaVariables({ CLICKHOUSE_URL: null })) });
    const { calls } = await runCli([], stub);
    expect(callsMatching(calls, '__type(')).toHaveLength(0);
  });

  it('skips the retention check, rather than passing it, without a ClickHouse DSN', async () => {
    const { output } = await runCli([], railwayStub());
    expect(output).toContain('Retention check skipped');
  });

  it('names the declared server version and the CLI it publishes with', async () => {
    const { output } = await runCli([], railwayStub());
    expect(output).toContain(`Declared server: ${OTA_SERVER_VERSION}`);
    expect(output).toContain(EOAS_PACKAGE_SPEC);
  });

  it('never prints a secret value, even the one it read', async () => {
    const stub = railwayStub({ variables: variablesWithOta(otaVariables({ CLICKHOUSE_URL: SECRET_DSN })) });
    const { output } = await runCli([], stub);
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain(SECRET_DSN);
  });

  it('never prints a secret it had to report on either', async () => {
    // A placeholder is the case where the tool holds the live value AND has
    // something to say about it — the one most likely to leak.
    const stub = railwayStub({ variables: variablesWithOta(otaVariables({ CLICKHOUSE_URL: `<${SECRET_DSN}>` })) });
    const { code, output } = await runCli([], stub);
    expect(code).toBe(1);
    expect(output).toContain('CLICKHOUSE_URL is placeholder');
    expect(output).not.toContain('hunter2');
  });

  it('prints the declared value of an owned variable and never the live one', async () => {
    const stub = railwayStub({ variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })) });
    const { code, output } = await runCli([], stub);
    expect(code).toBe(1);
    expect(output).toContain(OTA_BASE_URL);
    expect(output).not.toContain(WRONG_OWNED_VALUE);
  });

  it('names a supplied value without printing it', async () => {
    const stub = railwayStub({ variables: variablesWithOta(otaVariables({ CLICKHOUSE_URL: null })) });
    const { output } = await runCli([], stub, { RAILWAY_VAR_CLICKHOUSE_URL: SECRET_DSN });
    expect(output).toContain('Values supplied for: CLICKHOUSE_URL');
    expect(output).not.toContain('hunter2');
  });

  it('notes a live service nobody declared instead of proposing to remove it', async () => {
    const stub = railwayStub({ extraServices: [{ id: 'svc-new', name: 'boardsesh-experiment' }] });
    const { code, output } = await runCli([], stub);
    expect(output).toContain('boardsesh-experiment');
    expect(output).toContain('left untouched');
    // An unrecognised service is a note, not drift.
    expect(code).toBe(0);
  });

  it('reports the image drift it will not roll without being asked', async () => {
    const stub = railwayStub({
      instances: { [OTA_SERVICE_NAME]: { source: { image: `${OTA_IMAGE_REPOSITORY}:v3.0.5` } } },
    });
    const { code, output } = await runCli([], stub);
    expect(code).toBe(1);
    expect(output).toContain('--allow-image-change');
  });
});

describe('apply mode', () => {
  it('can converge an available service while reporting a different missing instance', async () => {
    const stub = railwayStub({
      missingInstances: [OTA_POSTGRES_SERVICE_NAME],
      variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })),
    });
    const { code, calls, error } = await runCli(['--apply', '--no-wait'], stub);
    expect(error).toBeNull();
    expect(code).toBe(1);
    expect(callsMatching(calls, 'variableUpsert').map((call) => call.variables.input)).toEqual([
      expect.objectContaining({ serviceId: OTA_SERVICE_ID, name: 'BASE_URL', value: OTA_BASE_URL }),
    ]);
    expect(callsMatching(calls, 'serviceInstanceDeployV2(').map((call) => call.variables.serviceId)).toEqual([
      OTA_SERVICE_ID,
    ]);
  });

  it('writes nothing at all when the project is already converged', async () => {
    const { code, calls } = await runCli(['--apply'], railwayStub());
    expect(code).toBe(0);
    expect(callsMatching(calls, 'variableUpsert')).toHaveLength(0);
    expect(callsMatching(calls, 'serviceInstanceUpdate(')).toHaveLength(0);
    expect(callsMatching(calls, 'serviceInstanceDeployV2(')).toHaveLength(0);
  });

  it('sets an owned variable to the value config.ts declares', async () => {
    const stub = railwayStub({ variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })) });
    const { code, calls, output } = await runCli(['--apply', '--no-wait'], stub);
    expect(code).toBe(0);
    const [upsert] = callsMatching(calls, 'variableUpsert');
    expect(upsert.variables.input).toMatchObject({
      projectId: 'test-project',
      environmentId: 'env-prod',
      serviceId: OTA_SERVICE_ID,
      name: 'BASE_URL',
      value: OTA_BASE_URL,
    });
    expect(output).not.toContain(WRONG_OWNED_VALUE);
  });

  it('writes a supplied secret without ever printing it', async () => {
    const stub = railwayStub({ variables: variablesWithOta(otaVariables({ CLICKHOUSE_URL: null })) });
    const { code, calls, output } = await runCli(['--apply', '--no-wait'], stub, {
      RAILWAY_VAR_CLICKHOUSE_URL: SECRET_DSN,
    });
    expect(code).toBe(0);
    const [upsert] = callsMatching(calls, 'variableUpsert');
    // The value has to reach Railway...
    expect(upsert.variables.input).toMatchObject({ name: 'CLICKHOUSE_URL', value: SECRET_DSN });
    // ...and must not reach the log.
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain(SECRET_DSN);
  });

  it('passes skipDeploys so a batch of variables does not roll one deployment each', async () => {
    const stub = railwayStub({
      variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE, STORAGE_MODE: 'local' })),
    });
    const { calls } = await runCli(['--apply', '--no-wait'], stub);
    const upserts = callsMatching(calls, 'variableUpsert');
    expect(upserts).toHaveLength(2);
    for (const upsert of upserts) expect(upsert.variables.input).toMatchObject({ skipDeploys: true });
    // One deploy for the pair, not one each.
    expect(callsMatching(calls, 'serviceInstanceDeployV2(')).toHaveLength(1);
  });

  it('threads the injected sleeper through post-deploy probe retries', async () => {
    const stub = railwayStub({
      variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })),
      probeStatuses: [503, 503, 200],
    });
    const sleeps: number[] = [];

    const { code } = await runCli(
      ['--apply'],
      stub,
      {},
      { sleep: async (milliseconds) => void sleeps.push(milliseconds) },
    );

    expect(code).toBe(0);
    expect(stub.probeCalls()).toBe(4);
    expect(sleeps.filter((milliseconds) => milliseconds === 5_000)).toHaveLength(2);
  });

  it('unwinds successful services in reverse when a later service fails', async () => {
    const variables = variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE }));
    variables[WEB_SERVICE_NAME] = { ...variables[WEB_SERVICE_NAME] };
    delete variables[WEB_SERVICE_NAME].SMTP_USER;
    const stub = railwayStub({
      variables,
      deploymentStatuses: [...Array(DEPLOY_SUCCESS_CONFIRMATIONS).fill('SUCCESS'), 'FAILED'],
    });
    const rollbacks: string[] = [];

    const { code, calls, output } = await runCli(
      ['--apply'],
      stub,
      { RAILWAY_VAR_SMTP_USER: 'smtp-user' },
      {
        rollbackDeployment: async ({ serviceId }) => {
          rollbacks.push(serviceId);
          return { deploymentId: `rollback-${serviceId}`, image: 'restored-image' };
        },
        sleep: async () => {},
      },
    );

    expect(code).toBe(1);
    expect(callsMatching(calls, 'serviceInstanceDeployV2(').map((call) => call.variables.serviceId)).toEqual([
      OTA_SERVICE_ID,
      liveServiceId(WEB_SERVICE_NAME),
    ]);
    expect(rollbacks).toEqual([liveServiceId(WEB_SERVICE_NAME), OTA_SERVICE_ID]);
    expect(output).toContain('Any variables written this run remain set');
  });

  it('does not restore configuration when a fenced rollback refuses to run', async () => {
    // A newer deployment appeared between the failed rollout and the rollback
    // preflight. The helper refuses on purpose; writing the pre-run image back now
    // would overwrite whatever that newer actor configured.
    const olderImage = `${OTA_IMAGE_REPOSITORY}:v3.0.5`;
    const stub = railwayStub({
      instances: { [OTA_SERVICE_NAME]: { source: { image: olderImage } } },
      deploymentStatuses: ['FAILED'],
    });
    const { code, calls, output, error } = await runCli(
      ['--apply', '--allow-image-change'],
      stub,
      {},
      {
        sleep: async () => {},
        rollbackDeployment: async () => {
          throw new RollbackFencedError(
            'Rollback preflight found a competing deployment between the target and expected current',
          );
        },
      },
    );

    expect(error).toBeNull();
    expect(code).toBe(1);
    // Only the forward write; no restore after the refused rollback.
    expect(callsMatching(calls, 'serviceInstanceUpdate(').map((call) => call.variables.input)).toEqual([
      { source: { image: OTA_IMAGE } },
    ]);
    expect(output).toMatch(/configuration was NOT restored/);
    expect(output).toContain(OTA_SERVICE_NAME);
  });

  it('still restores configuration when its own rollback deployment fails to settle', async () => {
    // The helper created the rollback deployment itself, so no newer actor owns the
    // service. Skipping the restore would leave it configured for the failed image
    // while serving the old one.
    const olderImage = `${OTA_IMAGE_REPOSITORY}:v3.0.5`;
    const stub = railwayStub({
      instances: { [OTA_SERVICE_NAME]: { source: { image: olderImage } } },
      deploymentStatuses: ['FAILED'],
    });
    const { code, calls, output, error } = await runCli(
      ['--apply', '--allow-image-change'],
      stub,
      {},
      {
        sleep: async () => {},
        rollbackDeployment: async () => {
          throw new Error('Railway rollback deployment did not reach SUCCESS in time');
        },
      },
    );

    expect(error).toBeNull();
    expect(code).toBe(1);
    expect(callsMatching(calls, 'serviceInstanceUpdate(').map((call) => call.variables.input)).toEqual([
      { source: { image: OTA_IMAGE } },
      { source: { image: olderImage } },
    ]);
    expect(output).toMatch(/rollback deployment did not settle/i);
    expect(output).not.toMatch(/configuration was NOT restored/);
  });

  it('restores an earlier service in a batch unwind when its rollback fails without a fence', async () => {
    const variables = convergedVariables();
    variables[WEB_SERVICE_NAME] = { ...variables[WEB_SERVICE_NAME] };
    delete variables[WEB_SERVICE_NAME].SMTP_USER;
    const stub = railwayStub({
      variables,
      instances: { [OTA_SERVICE_NAME]: { healthcheckTimeout: 300 } },
      deploymentStatuses: [...Array(DEPLOY_SUCCESS_CONFIRMATIONS).fill('SUCCESS'), 'FAILED'],
    });

    const { code, calls, output } = await runCli(
      ['--apply'],
      stub,
      { RAILWAY_VAR_SMTP_USER: 'smtp-user' },
      {
        rollbackDeployment: async ({ serviceId }) => {
          if (serviceId === OTA_SERVICE_ID)
            throw new Error('Railway rollback deployment reached terminal status FAILED');
          return { deploymentId: `rollback-${serviceId}`, image: 'restored-image' };
        },
        sleep: async () => {},
      },
    );

    expect(code).toBe(1);
    expect(callsMatching(calls, 'serviceInstanceUpdate(').map((call) => call.variables.input)).toEqual([
      { healthcheckTimeout: 100 },
      { healthcheckTimeout: 300 },
    ]);
    expect(output).toMatch(/rollback deployment did not settle/i);
  });

  it('does not restore an earlier service in a batch unwind when its rollback is refused', async () => {
    const variables = convergedVariables();
    variables[WEB_SERVICE_NAME] = { ...variables[WEB_SERVICE_NAME] };
    delete variables[WEB_SERVICE_NAME].SMTP_USER;
    const stub = railwayStub({
      variables,
      instances: { [OTA_SERVICE_NAME]: { healthcheckTimeout: 300 } },
      deploymentStatuses: [...Array(DEPLOY_SUCCESS_CONFIRMATIONS).fill('SUCCESS'), 'FAILED'],
    });
    const rollbacks: string[] = [];

    const { code, calls, output } = await runCli(
      ['--apply'],
      stub,
      { RAILWAY_VAR_SMTP_USER: 'smtp-user' },
      {
        rollbackDeployment: async ({ serviceId }) => {
          rollbacks.push(serviceId);
          if (serviceId === OTA_SERVICE_ID) {
            throw new RollbackFencedError('Expected current deployment is not the sole newest service deployment');
          }
          return { deploymentId: `rollback-${serviceId}`, image: 'restored-image' };
        },
        sleep: async () => {},
      },
    );

    expect(code).toBe(1);
    expect(rollbacks).toEqual([liveServiceId(WEB_SERVICE_NAME), OTA_SERVICE_ID]);
    expect(callsMatching(calls, 'serviceInstanceUpdate(').map((call) => call.variables.input)).toEqual([
      { healthcheckTimeout: 100 },
    ]);
    expect(output).toMatch(/configuration was NOT restored/);
  });

  it('probes the OTA server after a ClickHouse image change and rolls ClickHouse back when it fails', async () => {
    const olderClickHouse = 'ghcr.io/boardsesh/boardsesh-clickhouse@sha256:' + '0'.repeat(64);
    const clickhouseServiceId = liveServiceId(CLICKHOUSE_SERVICE_NAME);
    const stub = railwayStub({
      instances: { [CLICKHOUSE_SERVICE_NAME]: { source: { image: olderClickHouse } } },
      probeStatuses: [503],
    });
    const rollbacks: string[] = [];

    const { code, calls, output, error } = await runCli(
      ['--apply', '--allow-image-change'],
      stub,
      {},
      {
        rollbackDeployment: async ({ serviceId }) => {
          rollbacks.push(serviceId);
          return { deploymentId: 'rollback-clickhouse', image: olderClickHouse };
        },
        sleep: async () => {},
      },
    );

    expect(error).toBeNull();
    expect(code).toBe(1);
    expect(stub.probeCalls()).toBeGreaterThan(0);
    expect(output).toContain(`${OTA_BASE_URL}${OTA_HEALTHCHECK_PATH}`);
    expect(rollbacks).toEqual([clickhouseServiceId]);
    expect(callsMatching(calls, 'serviceInstanceUpdate(').map((call) => call.variables)).toEqual([
      expect.objectContaining({ serviceId: clickhouseServiceId, input: { source: { image: CLICKHOUSE_IMAGE } } }),
      expect.objectContaining({ serviceId: clickhouseServiceId, input: { source: { image: olderClickHouse } } }),
    ]);
  });

  it('batches deploy settings into a single serviceInstanceUpdate per service', async () => {
    const stub = railwayStub({
      instances: { [OTA_SERVICE_NAME]: { healthcheckTimeout: 300, drainingSeconds: 0 } },
    });
    const { code, calls } = await runCli(['--apply', '--no-wait'], stub);
    expect(code).toBe(0);
    const updates = callsMatching(calls, 'serviceInstanceUpdate(');
    expect(updates).toHaveLength(1);
    expect(updates[0].variables).toMatchObject({ environmentId: 'env-prod', serviceId: OTA_SERVICE_ID });
    expect(updates[0].variables.input).toEqual({ healthcheckTimeout: 100, drainingSeconds: 15 });
    // serviceInstanceUpdate writes configuration only; exactly one deploy picks it up.
    expect(callsMatching(calls, 'serviceInstanceDeployV2(')).toHaveLength(1);
  });

  it('lets an account token apply and verify non-image configuration', async () => {
    const stub = railwayStub({
      projectScoped: false,
      variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })),
      instances: { [OTA_SERVICE_NAME]: { healthcheckTimeout: 300 } },
    });

    const { code, calls, error } = await runCli(['--apply'], stub, {}, { sleep: async () => {} });

    expect(error).toBeNull();
    expect(code).toBe(0);
    expect(callsMatching(calls, 'projectToken')).toHaveLength(0);
    expect(callsMatching(calls, 'variableUpsert')).toHaveLength(1);
    expect(callsMatching(calls, 'serviceInstanceUpdate(')).toHaveLength(1);
    expect(callsMatching(calls, 'serviceInstanceDeployV2(')).toHaveLength(1);
  });

  it('rolls the declared image once the caller opted in', async () => {
    const stub = railwayStub({
      instances: { [OTA_SERVICE_NAME]: { source: { image: `${OTA_IMAGE_REPOSITORY}:v3.0.5` } } },
    });
    const { code, calls } = await runCli(['--apply', '--allow-image-change', '--no-wait'], stub);
    expect(code).toBe(0);
    const [update] = callsMatching(calls, 'serviceInstanceUpdate(');
    expect(update.variables.input).toEqual({ source: { image: OTA_IMAGE } });
    expect(callsMatching(calls, 'serviceInstanceDeployV2(')).toHaveLength(1);
  });

  it('refuses an image change with a token that cannot roll back', async () => {
    // railwayRequest probes both auth schemes, so an ACCOUNT token drives the whole
    // apply happily — but rollbackDeployment reads `projectToken` for its scope and
    // an account token answers null. Without this check the mismatch surfaces at the
    // one moment it matters: bad image live, probe failed, recovery dead on arrival.
    const stub = railwayStub({
      projectScoped: false,
      instances: { [OTA_SERVICE_NAME]: { source: { image: `${OTA_IMAGE_REPOSITORY}:v3.0.5` } } },
    });
    const { error, calls } = await runCli(['--apply', '--allow-image-change', '--no-wait'], stub);

    expect(error?.message).toMatch(/cannot roll back|PROJECT token/i);
    expect(callsMatching(calls, 'serviceInstanceUpdate(')).toHaveLength(0);
    expect(callsMatching(calls, 'serviceInstanceDeployV2(')).toHaveLength(0);
  });

  it('refuses an image change with a project token scoped to a different project', async () => {
    // A project token for ANOTHER project answers `projectToken` perfectly well, so
    // checking only that it answers would pass here and then fail during the
    // rollback with the bad image already live.
    const stub = railwayStub({
      tokenProjectId: 'some-other-project',
      instances: { [OTA_SERVICE_NAME]: { source: { image: `${OTA_IMAGE_REPOSITORY}:v3.0.5` } } },
    });
    const { error, calls } = await runCli(['--apply', '--allow-image-change', '--no-wait'], stub);

    expect(error?.message).toMatch(/cannot roll back this project/i);
    expect(callsMatching(calls, 'serviceInstanceUpdate(')).toHaveLength(0);
  });

  it("does not roll back a deployment that turned out to be somebody else's", async () => {
    // Someone changes the image between our write and our deploy, so the deployment
    // we triggered carries THEIR change. Rolling back would undo work this tool did
    // not do — which is what the error text has always promised.
    const stub = railwayStub({
      instances: {
        [OTA_SERVICE_NAME]: {
          source: { image: `${OTA_IMAGE_REPOSITORY}:v3.0.5` },
          activeDeployments: [
            {
              id: 'dep-previous',
              status: 'SUCCESS',
              meta: { image: `${OTA_IMAGE_REPOSITORY}:v3.0.5` },
              canRollback: true,
            },
          ],
        },
      },
      deploymentMeta: { image: 'ghcr.io/somebody/else:v9.9.9' },
    });
    const { code, output, calls } = await runCli(['--apply', '--allow-image-change'], stub);

    expect(code).toBe(1);
    expect(output).toMatch(/not ours to roll back/i);
    expect(callsMatching(calls, 'deploymentRollback')).toHaveLength(0);
  });

  it('leaves the image alone without the opt-in, and still exits non-zero', async () => {
    const stub = railwayStub({
      instances: { [OTA_SERVICE_NAME]: { source: { image: `${OTA_IMAGE_REPOSITORY}:v3.0.5` } } },
    });
    const { code, calls, output } = await runCli(['--apply', '--no-wait'], stub);
    expect(code).toBe(1);
    expect(output).toContain('SKIPPED (blocked)');
    expect(callsMatching(calls, 'serviceInstanceUpdate(')).toHaveLength(0);
    expect(callsMatching(calls, 'serviceInstanceDeployV2(')).toHaveLength(0);
  });

  it('suppresses every service write when blocked image drift shares the service', async () => {
    const stub = railwayStub({
      variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })),
      instances: {
        [OTA_SERVICE_NAME]: {
          source: { image: `${OTA_IMAGE_REPOSITORY}:v3.0.5` },
          healthcheckTimeout: 300,
        },
      },
    });
    const { code, calls, output } = await runCli(['--apply'], stub);
    expect(code).toBe(1);
    expect(output).toMatch(/No changes applied.*blocked image drift/);
    expect(callsMatching(calls, 'variableUpsert')).toHaveLength(0);
    expect(callsMatching(calls, 'serviceInstanceUpdate(')).toHaveLength(0);
    expect(callsMatching(calls, 'serviceInstanceDeployV2(')).toHaveLength(0);
  });

  it.each(['CANCELED', 'CANCELLED'])('does not roll back a %s deployment', async (status) => {
    const stub = railwayStub({
      variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })),
      deploymentStatuses: [status],
    });
    const { code, calls, output } = await runCli(['--apply'], stub);
    expect(code).toBe(1);
    expect(output).toMatch(/newer or manual action/);
    expect(callsMatching(calls, 'deploymentRollback')).toHaveLength(0);
  });

  it('refuses to invent a secret it was not given', async () => {
    const stub = railwayStub({ variables: variablesWithOta(otaVariables({ CLICKHOUSE_URL: null })) });
    const { code, calls, output } = await runCli(['--apply', '--no-wait'], stub);
    expect(callsMatching(calls, 'variableUpsert')).toHaveLength(0);
    expect(code).toBe(1);
    expect(output).toContain('blocked');
  });

  it('refuses to mutate a service with a deployment already in flight', async () => {
    const stub = railwayStub({
      instances: {
        [OTA_SERVICE_NAME]: {
          healthcheckTimeout: 300,
          activeDeployments: [
            ...convergedInstanceResponse(OTA).activeDeployments,
            { id: 'dep-live', status: 'DEPLOYING' },
          ],
        },
      },
    });
    const { error, calls } = await runCli(['--apply', '--no-wait'], stub);
    expect(error?.message).toMatch(/deployment in flight/);
    expect(callsMatching(calls, 'serviceInstanceUpdate(')).toHaveLength(0);
    expect(callsMatching(calls, 'serviceInstanceDeployV2(')).toHaveLength(0);
  });

  it('refuses to send a mutation whose input shape has changed under it', async () => {
    // Railway's own field list omits `source`; only the schema can be trusted, so a
    // schema that no longer carries it must stop the run rather than guess.
    const stub = railwayStub({
      instances: { [OTA_SERVICE_NAME]: { source: { image: `${OTA_IMAGE_REPOSITORY}:v3.0.5` } } },
      updateInputFields: DEFAULT_UPDATE_INPUT_FIELDS.filter((field) => field !== 'source'),
    });
    const { error, calls } = await runCli(['--apply', '--allow-image-change', '--no-wait'], stub);
    expect(error?.message).toMatch(/no longer accepts: source/);
    expect(callsMatching(calls, 'serviceInstanceUpdate(')).toHaveLength(0);
  });

  it('skips the poll and probe under --no-wait, and says so', async () => {
    const stub = railwayStub({ variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })) });
    const { output, calls } = await runCli(['--apply', '--no-wait'], stub);
    expect(output).toContain('--no-wait');
    expect(callsMatching(calls, 'deployment(id:')).toHaveLength(0);
  });

  it('exits non-zero on a deployment that failed, rather than reporting a convergence', async () => {
    const stub = railwayStub({
      variables: variablesWithOta(otaVariables({ BASE_URL: WRONG_OWNED_VALUE })),
      instances: {
        [OTA_SERVICE_NAME]: {
          // No rollback target: the tool must say so instead of pretending it recovered.
          activeDeployments: [
            { id: 'dep-previous', status: 'SUCCESS', meta: { image: OTA_IMAGE }, canRollback: false },
          ],
        },
      },
      deploymentStatuses: ['FAILED'],
    });
    const { code, output } = await runCli(['--apply'], stub);
    expect(code).toBe(1);
    expect(output).toMatch(/failed after deploy/);
    expect(output).toMatch(/No rollback target/);
    expect(output).not.toContain('converged to desired state');
  });

  it('prints help and does nothing at all', async () => {
    const stub = railwayStub();
    const { code, output, calls } = await runCli(['--help'], stub);
    expect(code).toBe(0);
    expect(output).toContain('railway-apply');
    expect(calls).toHaveLength(0);
  });
});

describe('Railway authentication', () => {
  // Railway hands out two token kinds. A project token in an Authorization
  // header — the shipped bug — comes back HTTP 200 with `Not Authorized`, so a
  // naive `response.ok` check treats total failure as success.
  function authGatedStub(accepted: 'project' | 'account'): {
    fetch: typeof globalThis.fetch;
    calls: RecordedCall[];
    schemesTried: string[];
  } {
    const core = railwayStub();
    const schemesTried: string[] = [];

    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const usedProject = headers['Project-Access-Token'] !== undefined;
      const usedAccount = headers.Authorization !== undefined;
      // The schema introspection is deliberately unauthenticated; it is not a probe.
      if (!usedProject && !usedAccount) return core.fetch(input, init);

      schemesTried.push(usedProject ? 'project' : 'account');
      if ((accepted === 'project') !== usedProject) {
        return new Response(JSON.stringify({ errors: [{ message: 'Not Authorized' }], data: null }), { status: 200 });
      }
      return core.fetch(input, init);
    }) as typeof globalThis.fetch;

    return { fetch: fetchStub, calls: core.calls, schemesTried };
  }

  async function runAgainst(accepted: 'project' | 'account'): Promise<{ code: number | null; schemesTried: string[] }> {
    const stub = authGatedStub(accepted);
    const { code } = await runCli([], stub);
    return { code, schemesTried: stub.schemesTried };
  }

  it('authenticates a project token, the kind this repo actually stores', async () => {
    const { code, schemesTried } = await runAgainst('project');
    expect(code).toBe(0);
    expect(schemesTried[0]).toBe('project');
  });

  it('falls back to Bearer for an account token instead of failing', async () => {
    const { code, schemesTried } = await runAgainst('account');
    expect(code).toBe(0);
    expect(schemesTried.slice(0, 2)).toEqual(['project', 'account']);
  });

  it('stops re-probing once a scheme answers', async () => {
    // Several requests are made per run; only the first should pay for a probe.
    const { schemesTried } = await runAgainst('account');
    expect(schemesTried.filter((scheme) => scheme === 'project')).toHaveLength(1);
  });

  it('does not leak a discovered scheme into the next run', async () => {
    await runAgainst('account');
    const { code, schemesTried } = await runAgainst('project');
    expect(code).toBe(0);
    expect(schemesTried[0]).toBe('project');
  });

  it('resets to the project scheme on demand', async () => {
    await runAgainst('account');
    resetAuthScheme();
    const { schemesTried } = await runAgainst('project');
    expect(schemesTried[0]).toBe('project');
  });
});

describe('the railway:apply entry point', () => {
  it('loads under tsx, the runner `vp run railway:apply` uses, and reaches its credential check', () => {
    // Vitest loads modules as ESM, so every test above passes even when the script
    // cannot start: on 2026-09-26 a static import of the rollback helper (an ES
    // module with top-level await) made tsx's CommonJS transform fail at load, and
    // the first production apply died before reading anything. Run it for real.
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const run = spawnSync('vp', ['exec', 'tsx', 'scripts/railway-apply.ts'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, RAILWAY_TOKEN: '', RAILWAY_PROJECT_ID: '' },
      timeout: 60_000,
    });
    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).not.toContain('Transform failed');
    expect(output).toContain('RAILWAY_TOKEN and RAILWAY_PROJECT_ID are both required');
    expect(run.status).toBe(1);
  }, 90_000);

  it("recognises the rollback helper's fenced error by name", () => {
    expect(isRollbackFenced(new RollbackFencedError('competing deployment'))).toBe(true);
    expect(isRollbackFenced(new Error('rollback deployment did not reach SUCCESS in time'))).toBe(false);
    expect(isRollbackFenced('RollbackFencedError')).toBe(false);
  });
});
