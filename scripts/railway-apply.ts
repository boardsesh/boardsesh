/// <reference types="node" />

/**
 * Config-as-code for the Railway project running the self-hosted xprem OTA server.
 * Reads the declarative desired state (infra/railway/config.ts), fetches the live
 * project state, diffs them (infra/railway/plan.ts), and reports or converges the
 * delta. Idempotent: a second run with no drift is a no-op.
 *
 * What it manages (and nothing else in the project):
 *   - Services: asserts the declared services exist. Services are NEVER created or
 *     deleted by this tool — see CREATION_IS_NOT_AUTOMATED in
 *     infra/railway/config.ts for why. Changing an EXISTING service is a different
 *     risk and is automated.
 *   - The container image: `boardsesh-ota-v3` runs the image named by
 *     OTA_SERVER_VERSION. Applying it rolls a deployment, waits for it, probes the
 *     server, and rolls back automatically if it does not answer. Gated behind
 *     --allow-image-change.
 *   - Deploy settings: healthcheck path and timeout, restart policy, draining.
 *   - Custom domains, volume mounts, replicas and region: read and REPORTED, never
 *     applied. Each is half of a change that lives somewhere else (DNS), a create,
 *     or a decision with a bill attached.
 *   - Variables: a variable declared with a value in config.ts is owned by this
 *     repo and converged. A variable declared by name only is a secret: asserted
 *     present and non-placeholder, never printed, and written only when the caller
 *     supplies its value as `RAILWAY_VAR_<NAME>`. A secret that is already set is
 *     never overwritten.
 *   - Variables that must NOT be set (xprem's control-plane mode). Reported only.
 *   - ClickHouse retention: asserts the TTLs on xprem's Observe tables. Skipped
 *     (not failed) when no CLICKHOUSE_URL is available to this process, matching how
 *     scripts/mobile-ota-health-check.ts skips without a PostHog key.
 *
 * Secrets are never printed. Variables with no declared value are reduced to
 * set/absent/placeholder in infra/railway/plan.ts before they reach any output path,
 * and the live value of an owned variable is never printed either — only the
 * declared one, which is already in git.
 *
 * Modes:
 *   (default)             Dry-run. Fetch live state, print the diff, exit non-zero if
 *                         any drift exists (so CI can gate on it). Never mutates.
 *   --apply               Perform only the needed, non-blocked mutations.
 *   --allow-image-change  Additionally permit the container image to move, which
 *                         rolls a deployment. Deliberately separate from --apply,
 *                         the same way cf:apply gates its zone-wide SSL change.
 *   --no-wait             Skip the post-deploy poll and probe. Local use only.
 *
 * Usage:
 *   RAILWAY_TOKEN=... RAILWAY_PROJECT_ID=... vp run railway:apply
 *   RAILWAY_TOKEN=... RAILWAY_PROJECT_ID=... vp run railway:apply -- --apply
 *   RAILWAY_TOKEN=... RAILWAY_PROJECT_ID=... vp run railway:apply -- --apply --allow-image-change
 *
 * Env:
 *   RAILWAY_TOKEN       (required) Railway API token. Same secret the deploy
 *                       workflow already uses against backboard.railway.com. The
 *                       rollback path needs a PROJECT token specifically: it derives
 *                       its scope from `projectToken { projectId environmentId }`.
 *   RAILWAY_PROJECT_ID  (required) The project holding the OTA services.
 *   RAILWAY_VAR_<NAME>  (optional) Value for a declared secret, enabling --apply
 *                       to converge it. Never logged.
 *   CLICKHOUSE_URL      (optional) Enables the retention assertion. Read-only use.
 *
 * The disk assertion needs no extra config: it reads the volume through Railway's
 * API, which CI can reach even though ClickHouse's private DSN host it cannot.
 *
 * See docs/railway.md and infra/railway/config.ts.
 */

import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CLICKHOUSE_DATABASE,
  CLICKHOUSE_VOLUME_NAME,
  OTA_SERVER_VERSION,
  desiredRailwayState,
} from '../infra/railway/config';
import type { DeploySettings, RailwayDesiredState } from '../infra/railway/config';
import { buildPlan, servicesNeedingInstanceRead, undeclaredServices, varKey } from '../infra/railway/plan';
import type {
  LiveCustomDomain,
  LiveService,
  LiveServiceInstance,
  LiveState,
  PlannedChange,
} from '../infra/railway/plan';
import { EOAS_PACKAGE_SPEC } from './lib/eoas';

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

/** Prefix for caller-supplied variable values. `RAILWAY_VAR_CLICKHOUSE_URL` -> `CLICKHOUSE_URL`. */
const SUPPLIED_VAR_PREFIX = 'RAILWAY_VAR_';

/** Poll cadence for a deployment this tool rolled. Mirrors .github/actions/railway-redeploy. */
const DEPLOY_POLL_ATTEMPTS = 90;
const DEPLOY_POLL_INTERVAL_MS = 10_000;
/**
 * Consecutive clean polls before a deployment is called good.
 *
 * Copied from the redeploy action rather than reinvented: Railway can report
 * SUCCESS transiently while replicas are still settling, and one confirmation has
 * been seen to be a lie.
 */
const DEPLOY_SUCCESS_CONFIRMATIONS = 3;

/** Probe attempts per path, and the gap between them. */
const PROBE_ATTEMPTS = 3;
const PROBE_RETRY_DELAY_MS = 5_000;

/** Railway's DeploymentStatus enum, from live introspection of the schema. */
const ACTIVE_DEPLOYMENT_STATUSES = new Set([
  'BUILDING',
  'DEPLOYING',
  'INITIALIZING',
  'NEEDS_APPROVAL',
  'QUEUED',
  'WAITING',
]);

export interface CliOptions {
  apply: boolean;
  allowImageChange: boolean;
  wait: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  let apply = false;
  let allowImageChange = false;
  let wait = true;
  let help = false;

  for (const argument of argv) {
    if (argument === '--') continue;
    else if (argument === '--apply') apply = true;
    else if (argument === '--dry-run') apply = false;
    else if (argument === '--allow-image-change') allowImageChange = true;
    else if (argument === '--no-wait') wait = false;
    else if (argument === '--help' || argument === '-h') help = true;
    // Reject typos loudly — a silently ignored --appply would dry-run when the
    // operator believed they applied.
    else throw new Error(`Unknown flag: ${argument} (see --help)`);
  }

  return { apply, allowImageChange, wait, help };
}

/**
 * Collect the variable values the caller supplied, as a name -> value map.
 *
 * Exported for tests. The returned values are secrets; only their KEYS ever reach
 * the plan layer or any log line.
 */
export function collectSuppliedVars(env: NodeJS.ProcessEnv): Map<string, string> {
  const supplied = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(SUPPLIED_VAR_PREFIX)) continue;
    const name = key.slice(SUPPLIED_VAR_PREFIX.length);
    if (name && value !== undefined && value.trim() !== '') supplied.set(name, value);
  }
  return supplied;
}

/**
 * Build the plan-layer key set from supplied values and the desired state.
 *
 * A value is only usable for a variable the config actually declares as a secret,
 * so an accidental `RAILWAY_VAR_JWT_SECRET` in the environment can never cause a
 * write to a variable this repo owns outright.
 */
export function suppliedVarKeys(desired: RailwayDesiredState, supplied: Map<string, string>): Set<string> {
  const keys = new Set<string>();
  for (const service of desired.services) {
    for (const required of service.requiredVars) {
      if (required.value === undefined && supplied.has(required.name)) keys.add(varKey(service.name, required.name));
    }
  }
  return keys;
}

interface GraphQLResponse<TData> {
  data?: TData;
  errors?: { message: string }[];
}

/**
 * Railway issues two kinds of token and they authenticate differently: an
 * account token travels in `Authorization: Bearer`, while a project token —
 * what this repo stores as RAILWAY_TOKEN, scoped to the OTA project and its
 * production environment — must travel in `Project-Access-Token`. The wrong
 * header comes back as a bare `Not Authorized` with HTTP 200, which reads like
 * a permissions problem rather than a header problem. Rather than make the
 * operator declare which kind they hold, try the other scheme once and keep
 * whichever answered.
 */
type AuthScheme = 'project' | 'account';

const AUTH_HEADER: Record<AuthScheme, (token: string) => Record<string, string>> = {
  project: (token) => ({ 'Project-Access-Token': token }),
  account: (token) => ({ Authorization: `Bearer ${token}` }),
};

let authScheme: AuthScheme = 'project';

/**
 * Reset the memoized scheme. The memo is what stops every request paying for a
 * failed probe, but a value that survives for the life of the process is a
 * hazard: one run (or one test) that flips it silently changes the header every
 * later caller sends. main() resets on entry so each run starts from a known
 * state, and tests can do the same.
 */
export function resetAuthScheme(): void {
  authScheme = 'project';
}

function isNotAuthorized(response: Response, rawBody: string): boolean {
  if (response.status === 401 || response.status === 403) return true;
  return rawBody.includes('Not Authorized');
}

function postGraphQL(token: string, scheme: AuthScheme, body: string): Promise<Response> {
  return fetch(RAILWAY_API, {
    method: 'POST',
    headers: { ...AUTH_HEADER[scheme](token), 'Content-Type': 'application/json' },
    body,
  });
}

async function railwayRequest<TData>(token: string, query: string, variables: Record<string, unknown>): Promise<TData> {
  const body = JSON.stringify({ query, variables });

  let response = await postGraphQL(token, authScheme, body);
  let rawBody = await response.text();

  if (isNotAuthorized(response, rawBody)) {
    const fallback: AuthScheme = authScheme === 'project' ? 'account' : 'project';
    const retried = await postGraphQL(token, fallback, body);
    const retriedBody = await retried.text();
    if (!isNotAuthorized(retried, retriedBody)) {
      authScheme = fallback;
      response = retried;
      rawBody = retriedBody;
    }
  }

  let envelope: GraphQLResponse<TData> | null = null;
  try {
    envelope = rawBody ? (JSON.parse(rawBody) as GraphQLResponse<TData>) : null;
  } catch {
    // Non-JSON body (e.g. an HTML error page) — handled below via the raw text.
  }

  if (!response.ok || !envelope || envelope.errors?.length) {
    const rendered = (envelope?.errors ?? []).map((error) => `  - ${error.message}`).join('\n');
    throw new Error(
      `Railway API request failed (HTTP ${response.status}).` +
        (rendered ? `\n${rendered}` : `\n  ${rawBody.slice(0, 500)}`),
    );
  }

  if (!envelope.data) throw new Error('Railway API returned no data.');
  return envelope.data;
}

const PROJECT_QUERY = `
  query Project($projectId: String!) {
    project(id: $projectId) {
      name
      environments { edges { node { id name } } }
      services { edges { node { id name } } }
    }
  }
`;

const VARIABLES_QUERY = `
  query Variables($projectId: String!, $environmentId: String!, $serviceId: String!) {
    variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
  }
`;

/**
 * Everything diffable about one service instance, in a single round trip.
 *
 * `domains` comes back on the service instance itself, so there is no separate
 * domains() call. `builder` and `buildEnvironment` are deliberately NOT selected:
 * Railway sets them even on an image-sourced service where they are vestigial, so
 * reading them would only invite someone to diff them and see permanent drift.
 */
const SERVICE_INSTANCE_QUERY = `
  query ServiceInstanceForApply($environmentId: String!, $serviceId: String!) {
    serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
      source { image }
      healthcheckPath
      healthcheckTimeout
      restartPolicyType
      restartPolicyMaxRetries
      drainingSeconds
      region
      numReplicas
      domains {
        customDomains { domain targetPort }
      }
      latestDeployment { id status createdAt meta canRollback }
      activeDeployments { id status }
    }
  }
`;

const VOLUMES_QUERY = `
  query Volumes($projectId: String!) {
    project(id: $projectId) {
      volumes {
        edges {
          node {
            name
            volumeInstances { edges { node { sizeMB currentSizeMB mountPath serviceId } } }
          }
        }
      }
    }
  }
`;

const VARIABLE_UPSERT = `
  mutation VariableUpsert($input: VariableUpsertInput!) {
    variableUpsert(input: $input)
  }
`;

const SERVICE_INSTANCE_UPDATE = `
  mutation ServiceInstanceUpdateForApply($environmentId: String!, $serviceId: String!, $input: ServiceInstanceUpdateInput!) {
    serviceInstanceUpdate(environmentId: $environmentId, serviceId: $serviceId, input: $input)
  }
`;

/**
 * Roll a new deployment and get its id back.
 *
 * Deliberately V2 and not `serviceInstanceRedeploy`: redeploy re-runs the previous
 * build and does not pick up an image written by serviceInstanceUpdate. This is the
 * GraphQL analogue of the `--from-source` flag .github/actions/railway-redeploy
 * already treats as load-bearing.
 *
 * The return is the new deployment's id, which removes every bit of
 * guess-which-deployment-is-mine machinery the CLI-based path needs.
 */
const SERVICE_INSTANCE_DEPLOY = `
  mutation ServiceInstanceDeployForApply($environmentId: String!, $serviceId: String!) {
    serviceInstanceDeployV2(environmentId: $environmentId, serviceId: $serviceId)
  }
`;

const DEPLOYMENT_QUERY = `
  query DeploymentForApply($id: String!) {
    deployment(id: $id) { id status meta }
  }
`;

/**
 * The query `rollbackDeployment` uses to derive its own scope.
 *
 * Asked BEFORE an image change, because the apply path and the recovery path do
 * not accept the same credential: `railwayRequest` probes both header schemes and
 * an ACCOUNT token drives the whole apply happily, while the rollback helper sends
 * only `Project-Access-Token` and reads `projectToken`, which an account token
 * answers as null. Without this check that mismatch surfaces at the single worst
 * moment — a bad image live, the probe failed, and the recovery immediately dying.
 */
const PROJECT_TOKEN_QUERY = `
  query ProjectTokenScopeForApply {
    projectToken { projectId environmentId }
  }
`;

/** Confirms the schema still has the fields the apply path writes. Unauthenticated. */
const UPDATE_INPUT_INTROSPECTION = `
  query ServiceInstanceUpdateInputShape {
    __type(name: "ServiceInstanceUpdateInput") { inputFields { name } }
  }
`;

interface ProjectData {
  project: {
    name: string;
    environments: { edges: { node: { id: string; name: string } }[] };
    services: { edges: { node: { id: string; name: string } }[] };
  };
}

interface ResolvedProject {
  projectName: string;
  environmentId: string;
  environmentNames: string[];
  services: LiveService[];
}

async function fetchProject(token: string, projectId: string, environmentName: string): Promise<ResolvedProject> {
  const data = await railwayRequest<ProjectData>(token, PROJECT_QUERY, { projectId });
  const environment = data.project.environments.edges.find((edge) => edge.node.name === environmentName);
  if (!environment) {
    const available = data.project.environments.edges.map((edge) => edge.node.name).join(', ');
    throw new Error(`No "${environmentName}" environment in project "${data.project.name}". Found: ${available}`);
  }

  return {
    projectName: data.project.name,
    environmentId: environment.node.id,
    environmentNames: data.project.environments.edges.map((edge) => edge.node.name),
    services: data.project.services.edges.map((edge) => ({ id: edge.node.id, name: edge.node.name })),
  };
}

/**
 * Read the variables for every service we assert anything about.
 *
 * Only those services are queried: this tool has no reason to pull the secrets of
 * a service it merely lists in the inventory.
 */
async function fetchVariables(
  token: string,
  projectId: string,
  environmentId: string,
  desired: RailwayDesiredState,
  services: LiveService[],
): Promise<Record<string, Record<string, string>>> {
  const variables: Record<string, Record<string, string>> = {};

  for (const declared of desired.services) {
    const live = services.find((service) => service.name === declared.name);
    const wantsVars = declared.requiredVars.length > 0 || (declared.forbiddenVars?.length ?? 0) > 0;
    if (!live || !wantsVars) continue;
    const data = await railwayRequest<{ variables: Record<string, string> }>(token, VARIABLES_QUERY, {
      projectId,
      environmentId,
      serviceId: live.id,
    });
    variables[declared.name] = data.variables ?? {};
  }

  return variables;
}

interface ServiceInstanceData {
  serviceInstance: {
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
    activeDeployments: { id: string; status: string }[];
  } | null;
}

/** The bits of a deployment the apply path fences on. */
interface DeploymentSnapshot {
  id: string;
  status: string;
  image: string | null;
  canRollback: boolean;
}

interface InstanceRead {
  instance: LiveServiceInstance;
  latestDeployment: DeploymentSnapshot | null;
  activeDeployments: { id: string; status: string }[];
}

/** `meta` is an untyped Railway scalar; `meta.image` is a runtime contract, not a schema one. */
function deploymentImage(meta: unknown): string | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const image = (meta as { image?: unknown }).image;
  return typeof image === 'string' && image.trim() !== '' ? image : null;
}

async function fetchServiceInstances(
  token: string,
  environmentId: string,
  desired: RailwayDesiredState,
  services: LiveService[],
  volumeMountsByService: Map<string, string[]>,
): Promise<Map<string, InstanceRead>> {
  const reads = new Map<string, InstanceRead>();

  for (const name of servicesNeedingInstanceRead(desired)) {
    const live = services.find((service) => service.name === name);
    if (!live) continue;

    const data = await railwayRequest<ServiceInstanceData>(token, SERVICE_INSTANCE_QUERY, {
      environmentId,
      serviceId: live.id,
    });
    const raw = data.serviceInstance;
    if (!raw) continue;

    const customDomains: LiveCustomDomain[] = (raw.domains?.customDomains ?? []).map((domain) => ({
      domain: domain.domain,
      targetPort: domain.targetPort,
    }));

    reads.set(name, {
      instance: {
        image: raw.source?.image ?? null,
        runningImage: deploymentImage(raw.latestDeployment?.meta),
        healthcheckPath: raw.healthcheckPath,
        healthcheckTimeout: raw.healthcheckTimeout,
        restartPolicyType: raw.restartPolicyType,
        restartPolicyMaxRetries: raw.restartPolicyMaxRetries,
        drainingSeconds: raw.drainingSeconds,
        region: raw.region,
        numReplicas: raw.numReplicas,
        customDomains,
        volumeMountPaths: volumeMountsByService.get(live.id) ?? [],
      },
      latestDeployment: raw.latestDeployment
        ? {
            id: raw.latestDeployment.id,
            status: raw.latestDeployment.status,
            image: deploymentImage(raw.latestDeployment.meta),
            canRollback: raw.latestDeployment.canRollback,
          }
        : null,
      activeDeployments: raw.activeDeployments ?? [],
    });
  }

  return reads;
}

interface VolumesData {
  project: {
    volumes: {
      edges: {
        node: {
          name: string;
          volumeInstances: {
            edges: { node: { sizeMB: number; currentSizeMB: number; mountPath: string; serviceId: string | null } }[];
          };
        };
      }[];
    };
  };
}

interface VolumeRead {
  clickhouse: { usedMb: number; capacityMb: number } | null;
  mountsByService: Map<string, string[]>;
}

/**
 * Read the volumes once, for two purposes.
 *
 * The ClickHouse utilisation is deliberately sourced from Railway's API rather than
 * from ClickHouse: the DSN host resolves only inside Railway's private network, so
 * a CI runner cannot ask ClickHouse anything — but it can ask Railway. That is what
 * lets the disk assertion run nightly when the retention one cannot. The same read
 * also yields which service has a volume mounted where, which is what catches a
 * volume that came detached.
 */
export async function fetchVolumes(token: string, projectId: string, volumeName: string): Promise<VolumeRead> {
  const data = await railwayRequest<VolumesData>(token, VOLUMES_QUERY, { projectId });
  const mountsByService = new Map<string, string[]>();
  let clickhouse: { usedMb: number; capacityMb: number } | null = null;

  for (const volumeEdge of data.project.volumes.edges) {
    for (const instanceEdge of volumeEdge.node.volumeInstances.edges) {
      const instance = instanceEdge.node;
      if (instance.serviceId) {
        const existing = mountsByService.get(instance.serviceId) ?? [];
        existing.push(instance.mountPath);
        mountsByService.set(instance.serviceId, existing);
      }
      if (volumeEdge.node.name === volumeName && clickhouse === null) {
        clickhouse = { usedMb: instance.currentSizeMB, capacityMb: instance.sizeMB };
      }
    }
  }

  return { clickhouse, mountsByService };
}

/**
 * Pull the TTL clause out of a table's `engine_full`.
 *
 * Returns '' for a table with no TTL, which is what the plan layer already
 * treats as "no retention set".
 */
export function ttlFromEngineFull(engineFull: string): string {
  const match = /\bTTL\s+(.*?)(?:\s+SETTINGS\b|$)/.exec(engineFull);
  return match ? match[1].trim() : '';
}

/**
 * Read the live TTL expressions from ClickHouse over its HTTP interface.
 *
 * Returns null when no DSN is available, which the plan layer treats as "not
 * checked" rather than "no drift". A failure to reach a ClickHouse that WAS
 * configured is a real error and propagates.
 */
export async function fetchClickHouseTtl(
  dsn: string | undefined,
  database: string,
): Promise<Record<string, string> | null> {
  if (!dsn) return null;

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error(`Refusing to query a database name that is not a plain identifier: ${database}`);
  }

  const url = new URL(dsn);
  // The native-protocol DSN xprem uses names port 9000; the HTTP interface this
  // read-only query needs is 8123 on the same host.
  // Native 9000 maps to HTTP 8123, and native-over-TLS 9440 to HTTPS 8443. An
  // explicit port is passed through, which is what lets a Railway TCP proxy
  // (some arbitrary high port) be pointed at directly.
  const secure = url.protocol === 'clickhouses:';
  const defaultHttpPort = secure ? '8443' : '8123';
  const nativePorts = secure ? ['9440', ''] : ['9000', ''];
  const httpPort = nativePorts.includes(url.port) ? defaultHttpPort : url.port;
  const endpoint = `${secure ? 'https' : 'http'}://${url.hostname}:${httpPort}/`;
  // system.tables has no ttl_expression column — asking for one is an
  // UNKNOWN_IDENTIFIER error, not an empty result. The TTL clause lives inside
  // engine_full, between the engine's ORDER BY and its SETTINGS.
  const query = `SELECT name, engine_full FROM system.tables ` + `WHERE database = '${database}' FORMAT TabSeparated`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': decodeURIComponent(url.username),
      'X-ClickHouse-Key': decodeURIComponent(url.password),
    },
    body: query,
  });

  if (!response.ok) {
    throw new Error(`ClickHouse TTL query failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
  }

  const ttl: Record<string, string> = {};
  for (const line of (await response.text()).split('\n')) {
    if (!line.trim()) continue;
    const [table, engineFull = ''] = line.split('\t');
    ttl[table] = ttlFromEngineFull(engineFull);
  }
  return ttl;
}

/**
 * Confirm the schema still carries the input fields the apply path writes.
 *
 * Railway's published field list for `ServiceInstanceUpdateInput` is hand-curated
 * and omits both `source` and `drainingSeconds`, so the only trustworthy answer is
 * the schema itself. Introspection is open on this endpoint, so this costs one
 * unauthenticated POST and removes the guesswork entirely: if a field this tool
 * writes ever disappears, it says so instead of sending a mutation nobody can
 * reason about.
 */
export async function fetchUpdateInputFields(): Promise<Set<string>> {
  const response = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: UPDATE_INPUT_INTROSPECTION }),
  });
  if (!response.ok) throw new Error(`Railway schema introspection failed (HTTP ${response.status}).`);
  const envelope = (await response.json()) as GraphQLResponse<{
    __type: { inputFields: { name: string }[] } | null;
  }>;
  const fields = envelope.data?.__type?.inputFields;
  if (!fields) throw new Error('Railway schema introspection returned no ServiceInstanceUpdateInput.');
  return new Set(fields.map((field) => field.name));
}

/** Whether this token can drive the rollback path, not merely the apply path. */
export async function canRollBack(token: string): Promise<boolean> {
  try {
    const data = await railwayRequest<{ projectToken: { projectId: string } | null }>(token, PROJECT_TOKEN_QUERY, {});
    return Boolean(data.projectToken?.projectId);
  } catch {
    return false;
  }
}

function printPlan(changes: PlannedChange[]): void {
  for (const change of changes) {
    const marker = change.blocked ? '[blocked]' : '[change] ';
    console.log(`  ${marker} (${change.resource}) ${change.summary}`);
    if (change.detail) {
      for (const line of change.detail.split('\n')) console.log(`             ${line}`);
    }
  }
}

function printHelp(): void {
  console.log(
    [
      'railway-apply — config-as-code for the Railway OTA project.',
      '',
      '  vp run railway:apply                                    dry-run; exits non-zero on drift',
      '  vp run railway:apply -- --apply                         converge everything but the image',
      '  vp run railway:apply -- --apply --allow-image-change    also roll a new server image',
      '  vp run railway:apply -- --apply --no-wait               skip the post-deploy poll and probe',
      '',
      'Required env: RAILWAY_TOKEN, RAILWAY_PROJECT_ID',
      'Optional env: RAILWAY_VAR_<NAME> (a value --apply may set), CLICKHOUSE_URL (TTL check)',
    ].join('\n'),
  );
}

/**
 * Raised when a deployment this tool triggered turns out to carry somebody else's
 * image.
 *
 * Its own class because the recovery differs: every other failure rolls back, and
 * this one must NOT. Rolling back here would undo a change this tool did not make
 * and overwrite the other party's configured image — while the error text promised
 * it would not.
 */
export class DeploymentRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentRaceError';
  }
}

/**
 * Raised when the deployment is parked waiting for a human to approve it.
 *
 * Not a failure, so it must not roll back: nothing is broken, and cancelling a
 * deployment nobody has judged yet is not this tool's call. It shares the
 * no-rollback path with DeploymentRaceError.
 */
export class DeploymentApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentApprovalError';
  }
}

/** Poll a deployment this tool created until it settles, or throw. */
async function waitForDeployment(
  token: string,
  deploymentId: string,
  expectedImage: string | null,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let confirmations = 0;

  for (let attempt = 0; attempt < DEPLOY_POLL_ATTEMPTS; attempt += 1) {
    const data = await railwayRequest<{ deployment: { id: string; status: string; meta: unknown } }>(
      token,
      DEPLOYMENT_QUERY,
      { id: deploymentId },
    );
    const status = data.deployment.status;
    const liveImage = deploymentImage(data.deployment.meta);

    // Someone else deployed on top of ours. Fail closed rather than roll back over
    // a change this tool did not make.
    if (expectedImage && liveImage && liveImage !== expectedImage) {
      throw new DeploymentRaceError(
        `Deployment ${deploymentId} reports image ${liveImage}, expected ${expectedImage} — ` +
          `another deploy raced this one. Not rolling back; reconcile by hand.`,
      );
    }

    if (status === 'SUCCESS') {
      confirmations += 1;
      if (confirmations >= DEPLOY_SUCCESS_CONFIRMATIONS) return;
    } else {
      confirmations = 0;
      if (status === 'NEEDS_APPROVAL') {
        throw new DeploymentApprovalError(
          `Deployment ${deploymentId} is parked waiting for approval in Railway. Nothing was rolled ` +
            `back — approve it (or cancel it) there, then re-run.`,
        );
      }
      if (!ACTIVE_DEPLOYMENT_STATUSES.has(status)) {
        throw new Error(`Deployment ${deploymentId} finished as ${status}.`);
      }
    }

    await sleep(DEPLOY_POLL_INTERVAL_MS);
  }

  throw new Error(`Deployment ${deploymentId} did not settle within ${DEPLOY_POLL_ATTEMPTS} polls.`);
}

/**
 * Probe the endpoints the service is supposed to answer.
 *
 * A Railway deployment reaching SUCCESS means the container started. It does not
 * mean xprem is serving manifests. This is the difference between the two.
 */
export async function probeService(
  verify: { baseUrl: string; paths: string[] },
  sleep: (ms: number) => Promise<void> = (ms) => delay(ms),
): Promise<void> {
  for (const path of verify.paths) {
    const url = `${verify.baseUrl}${path}`;
    let lastFailure = '';

    // Retried, because this runs during the switchover the service's own
    // drainingSeconds exists to cover. A single 502 from the edge is
    // indistinguishable from a broken server, and treating it as one would roll
    // back a perfectly healthy production deployment.
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (response.ok) {
          console.log(`[railway-apply] probe ok: ${url}`);
          lastFailure = '';
          break;
        }
        lastFailure = `HTTP ${response.status}`;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }
      if (attempt < PROBE_ATTEMPTS) {
        console.warn(`[railway-apply] probe ${url} attempt ${attempt}/${PROBE_ATTEMPTS}: ${lastFailure}; retrying.`);
        await sleep(PROBE_RETRY_DELAY_MS);
      }
    }

    if (lastFailure) throw new Error(`Post-deploy probe failed: ${url} answered ${lastFailure}.`);
  }
}

/** Everything one service's apply needs to write, gathered from the plan. */
interface ServiceMutation {
  serviceName: string;
  serviceId: string;
  deployFields: Partial<Record<keyof DeploySettings, string | number>>;
  image?: string;
}

function collectServiceMutations(changes: PlannedChange[], services: LiveService[]): Map<string, ServiceMutation> {
  const mutations = new Map<string, ServiceMutation>();

  const ensure = (serviceName: string): ServiceMutation | null => {
    const service = services.find((candidate) => candidate.name === serviceName);
    if (!service) return null;
    const existing = mutations.get(serviceName);
    if (existing) return existing;
    const created: ServiceMutation = { serviceName, serviceId: service.id, deployFields: {} };
    mutations.set(serviceName, created);
    return created;
  };

  for (const change of changes) {
    if (change.blocked || !change.service) continue;
    if (change.resource === 'deploy-setting' && change.deployField) {
      const mutation = ensure(change.service);
      if (mutation) mutation.deployFields[change.deployField.name] = change.deployField.value;
    } else if (change.resource === 'service-image' && change.image) {
      const mutation = ensure(change.service);
      if (mutation) mutation.image = change.image;
    }
  }

  return mutations;
}

/**
 * Restore a service's declared image after a failed roll.
 *
 * This is the failure mode the image feature introduces and the one most worth
 * getting right: `deploymentRollback` restores the running container, but the
 * service's configured `source.image` would still name the bad tag, so the next
 * unrelated deploy would silently ship it again.
 */
async function restoreImage(
  token: string,
  environmentId: string,
  mutation: ServiceMutation,
  previousImage: string,
): Promise<void> {
  await railwayRequest(token, SERVICE_INSTANCE_UPDATE, {
    environmentId,
    serviceId: mutation.serviceId,
    input: { source: { image: previousImage } },
  });
  console.log(`[railway-apply] restored ${mutation.serviceName} image to ${previousImage}`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  resetAuthScheme();
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  const token = process.env.RAILWAY_TOKEN?.trim();
  const projectId = process.env.RAILWAY_PROJECT_ID?.trim();
  if (!token || !projectId) {
    console.error('[railway-apply] RAILWAY_TOKEN and RAILWAY_PROJECT_ID are both required.');
    console.error('                RAILWAY_TOKEN is the same secret the production deploy uses.');
    return 1;
  }

  const desired = desiredRailwayState;
  const supplied = collectSuppliedVars(process.env);

  const project = await fetchProject(token, projectId, desired.environmentName);
  console.log(`[railway-apply] Project: ${project.projectName} (${desired.environmentName})`);
  console.log(`[railway-apply] Mode: ${options.apply ? 'APPLY' : 'dry-run (pass --apply to converge)'}`);
  console.log(`[railway-apply] Declared server: ${OTA_SERVER_VERSION} (publishing with ${EOAS_PACKAGE_SPEC})`);
  if (supplied.size > 0) {
    // Names only, never values.
    console.log(`[railway-apply] Values supplied for: ${[...supplied.keys()].sort().join(', ')}`);
  }
  console.log('');

  const clickhouseTtl = await fetchClickHouseTtl(process.env.CLICKHOUSE_URL?.trim(), CLICKHOUSE_DATABASE);
  if (clickhouseTtl === null) {
    console.log('[railway-apply] Retention check skipped: no CLICKHOUSE_URL in this environment.');
  }

  // Railway's API answers this even from CI, unlike ClickHouse itself.
  const volumes = await fetchVolumes(token, projectId, CLICKHOUSE_VOLUME_NAME);
  if (volumes.clickhouse === null) {
    console.log(`[railway-apply] Disk check skipped: no volume named "${CLICKHOUSE_VOLUME_NAME}".`);
  } else {
    const usedPercent = (volumes.clickhouse.usedMb / volumes.clickhouse.capacityMb) * 100;
    console.log(
      `[railway-apply] ClickHouse volume: ${(volumes.clickhouse.usedMb / 1024).toFixed(1)} GiB of ` +
        `${(volumes.clickhouse.capacityMb / 1024).toFixed(1)} GiB (${usedPercent.toFixed(1)}%).`,
    );
  }

  const instanceReads = await fetchServiceInstances(
    token,
    project.environmentId,
    desired,
    project.services,
    volumes.mountsByService,
  );

  const live: LiveState = {
    services: project.services,
    variables: await fetchVariables(token, projectId, project.environmentId, desired, project.services),
    instances: Object.fromEntries([...instanceReads].map(([name, read]) => [name, read.instance])),
    clickhouseTtl,
    clickhouseVolume: volumes.clickhouse,
  };

  for (const name of undeclaredServices(desired, live)) {
    console.log(`[railway-apply] note: service "${name}" is live but not declared here — left untouched.`);
  }

  const changes = buildPlan(desired, live, {
    suppliedVars: suppliedVarKeys(desired, supplied),
    allowImageChange: options.allowImageChange,
    eoasVersion: EOAS_PACKAGE_SPEC.replace(/^eoas@/, ''),
  });

  if (changes.length === 0) {
    console.log('[railway-apply] In sync — nothing to do.');
    return 0;
  }

  console.log(`[railway-apply] Planned changes (${changes.length}):`);
  printPlan(changes);
  console.log('');

  if (!options.apply) {
    console.log('[railway-apply] Dry-run: no changes applied. Re-run with --apply to converge.');
    // Non-zero exit signals drift so CI can gate on it.
    return 1;
  }

  const mutations = collectServiceMutations(changes, project.services);

  // Variables are written with skipDeploys so a batch does not roll one deployment
  // per variable; a single deploy per service picks them all up afterwards. That
  // means a service carrying only variable drift still needs a mutation entry.
  for (const change of changes) {
    if (change.blocked || change.resource !== 'env-var' || !change.target) continue;
    const serviceName = change.target.serviceName;
    if (mutations.has(serviceName)) continue;
    const service = project.services.find((candidate) => candidate.name === serviceName);
    if (service) mutations.set(serviceName, { serviceName, serviceId: service.id, deployFields: {} });
  }

  // Quiescence is checked for every service before the first write, not per service
  // as its turn comes up. Discovering an in-flight deployment halfway through would
  // mean aborting with some variables already written and no deployment rolled to
  // carry them.
  for (const serviceName of mutations.keys()) {
    const read = instanceReads.get(serviceName);
    const inFlight = read?.activeDeployments.filter((deployment) => ACTIVE_DEPLOYMENT_STATUSES.has(deployment.status));
    if (inFlight && inFlight.length > 0) {
      throw new Error(
        `${serviceName} has a deployment in flight (${inFlight[0].status}). Refusing to mutate a ` +
          `service that is not quiet — re-run once it settles.`,
      );
    }
  }

  if (mutations.size > 0) {
    const updateFields = await fetchUpdateInputFields();
    const needed = new Set<string>();
    for (const mutation of mutations.values()) {
      if (mutation.image) needed.add('source');
      for (const field of Object.keys(mutation.deployFields)) needed.add(field);
    }
    const missing = [...needed].filter((field) => !updateFields.has(field));
    if (missing.length > 0) {
      throw new Error(
        `Railway's ServiceInstanceUpdateInput no longer accepts: ${missing.join(', ')}. ` +
          `Refusing to send a mutation whose shape has changed.`,
      );
    }

    if (needed.has('source') && !(await canRollBack(token))) {
      throw new Error(
        'Refusing to change a container image with a token that cannot roll back. The rollback ' +
          'path needs a Railway PROJECT token (it reads `projectToken` for its scope); this one ' +
          'answers the apply calls but not that. Use the project token the production deploy uses.',
      );
    }
  }

  let blockedRemaining = 0;

  for (const change of changes) {
    if (change.blocked) {
      console.warn(`[railway-apply] SKIPPED (blocked): ${change.summary}`);
      blockedRemaining += 1;
      continue;
    }

    if (change.resource === 'env-var' && change.target) {
      const service = project.services.find((candidate) => candidate.name === change.target?.serviceName);
      const declared = desired.services
        .find((candidate) => candidate.name === change.target?.serviceName)
        ?.requiredVars.find((candidate) => candidate.name === change.target?.varName);
      const value = declared?.value ?? supplied.get(change.target.varName);
      if (!service || value === undefined) {
        throw new Error(`Cannot apply ${change.summary}: service or supplied value went missing mid-run.`);
      }
      await railwayRequest(token, VARIABLE_UPSERT, {
        input: {
          projectId,
          environmentId: project.environmentId,
          serviceId: service.id,
          name: change.target.varName,
          value,
          skipDeploys: true,
        },
      });
      console.log(`[railway-apply] applied: ${change.summary}`);
    } else if (change.resource === 'deploy-setting' || change.resource === 'service-image') {
      // Batched into one serviceInstanceUpdate per service below.
      continue;
    } else {
      // Every other resource is report-only by construction; reaching here means a
      // new resource type was added to the plan without an apply path.
      throw new Error(`No apply path for resource "${change.resource}" — ${change.summary}`);
    }
  }

  for (const mutation of mutations.values()) {
    const read = instanceReads.get(mutation.serviceName);
    const previousDeployment = read?.latestDeployment ?? null;
    const previousImage = read?.instance.image ?? null;
    const desiredService = desired.services.find((candidate) => candidate.name === mutation.serviceName);

    const input: Record<string, unknown> = { ...mutation.deployFields };
    if (mutation.image) input.source = { image: mutation.image };

    if (Object.keys(input).length > 0) {
      await railwayRequest(token, SERVICE_INSTANCE_UPDATE, {
        environmentId: project.environmentId,
        serviceId: mutation.serviceId,
        input,
      });
      const written = [...Object.keys(mutation.deployFields), ...(mutation.image ? ['image'] : [])].join(', ');
      console.log(`[railway-apply] applied: ${mutation.serviceName} ${written}`);
    }

    // serviceInstanceUpdate writes configuration only — the running container keeps
    // what it was created with until the next deployment. So every applied change
    // needs one, including a healthcheck path.
    // Never retried: an ambiguous response may already have created a deployment,
    // and a second call would create another.
    let deploymentId: string;
    try {
      const deployData = await railwayRequest<{ serviceInstanceDeployV2: string }>(token, SERVICE_INSTANCE_DEPLOY, {
        environmentId: project.environmentId,
        serviceId: mutation.serviceId,
      });
      deploymentId = deployData.serviceInstanceDeployV2;
    } catch (error) {
      // The window between writing config and rolling the deployment that carries
      // it. Nothing is verified and nothing runs the new config, but the service is
      // now CONFIGURED for it — so the next deploy for any unrelated reason ships
      // it, unprobed. infra/railway/plan.ts reports this split on the next run.
      console.error(
        `[railway-apply] MANUAL ACTION: ${mutation.serviceName} is now configured for ` +
          `${mutation.image ?? 'the declared settings'} but no deployment was rolled to carry it. ` +
          `Deploy it in Railway, or set the image back to ${previousImage ?? '(unknown)'}.`,
      );
      throw error;
    }
    console.log(`[railway-apply] rolled ${mutation.serviceName} deployment ${deploymentId}`);

    if (!options.wait) {
      console.log('[railway-apply] --no-wait: not polling or probing. Check Railway yourself.');
      continue;
    }

    if (mutation.image && !previousDeployment?.canRollback) {
      console.warn(
        `[railway-apply] WARNING: ${mutation.serviceName} has no rollback target ` +
          `(previous deployment ${previousDeployment?.id ?? 'unknown'} cannot be rolled back). ` +
          `A failed deploy will need manual recovery.`,
      );
    }

    try {
      await waitForDeployment(token, deploymentId, mutation.image ?? previousImage, (ms) => delay(ms));
      if (desiredService?.verify) await probeService(desiredService.verify);
      console.log(`[railway-apply] ${mutation.serviceName} is healthy on deployment ${deploymentId}.`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[railway-apply] ${mutation.serviceName} failed after deploy: ${reason}`);

      if (error instanceof DeploymentApprovalError) {
        console.error('[railway-apply] Leaving it alone: a parked deployment is for a human to release.');
        return 1;
      }

      if (error instanceof DeploymentRaceError) {
        // Somebody changed the image between our write and our deploy, so the
        // deployment we triggered carries THEIR change. Rolling back would undo
        // work this tool did not do — and the error text already promised not to.
        console.error('[railway-apply] Leaving it alone: this deployment is not ours to roll back.');
        return 1;
      }

      if (!previousDeployment?.canRollback || !previousImage) {
        console.error(
          '[railway-apply] No rollback target available. Reconcile by hand — this is not recoverable here.',
        );
        return 1;
      }

      console.error(`[railway-apply] Rolling back to deployment ${previousDeployment.id}.`);
      // Imported here rather than at the top: scripts/railway-deployment-rollback.mjs
      // has a top-level `await` in its CLI guard, and tsx compiles this file to CJS,
      // which cannot `require` such a module. A dynamic import can. It also means the
      // rollback machinery is only loaded on the path that needs it.
      const { rollbackDeployment } = await import('./railway-deployment-rollback.mjs');
      await rollbackDeployment({
        serviceId: mutation.serviceId,
        targetDeploymentId: previousDeployment.id,
        expectedCurrentDeploymentId: deploymentId,
        token,
      });
      if (mutation.image) {
        try {
          await restoreImage(token, project.environmentId, mutation, previousImage);
        } catch (restoreError) {
          // The container is back on the old image, but the service is still
          // CONFIGURED for the bad one, so the next deploy re-ships it. This is the
          // worst state the tool can reach, and it must never be quiet.
          const reason = restoreError instanceof Error ? restoreError.message : String(restoreError);
          console.error(
            `[railway-apply] MANUAL ACTION: rolled the container back, but could not restore the ` +
              `configured image (${reason}). ${mutation.serviceName} still names ${mutation.image}; ` +
              `set it back to ${previousImage} in Railway before anything redeploys it.`,
          );
          return 1;
        }
      }

      // Variables were upserted with skipDeploys and are NOT undone by a deployment
      // rollback, so claiming nothing was applied would be a lie.
      console.error('[railway-apply] Rolled back the deployment. Any variables written this run remain set.');
      return 1;
    }
  }

  console.log('');
  if (blockedRemaining > 0) {
    console.log(
      `[railway-apply] Done, but ${blockedRemaining} change(s) were blocked and left unapplied ` +
        `(they need a human, or a value this tool was not given).`,
    );
    return 1;
  }

  console.log('[railway-apply] Done — project converged to desired state.');
  return 0;
}

// Exported for docs/tests: the module can be imported without running the CLI.
export { ACTIVE_DEPLOYMENT_STATUSES, RAILWAY_API, SUPPLIED_VAR_PREFIX, waitForDeployment };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[railway-apply] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
