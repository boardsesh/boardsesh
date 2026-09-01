/// <reference types="node" />

/**
 * Config-as-code for the Railway project running the self-hosted xprem OTA server.
 * Reads the declarative desired state (infra/railway/config.ts), fetches the live
 * project state, diffs them (infra/railway/plan.ts), and reports or converges the
 * delta. Idempotent: a second run with no drift is a no-op.
 *
 * What it manages (and nothing else in the project):
 *   - Services: asserts `boardsesh-ota-v3` exists, and reports when the ClickHouse
 *     service is missing. Services are NEVER created or deleted by this tool — see
 *     CREATION_IS_NOT_AUTOMATED in infra/railway/config.ts for why.
 *   - Variables: asserts the declared variables are set and are not still an
 *     unfilled `<placeholder>`. A variable is only WRITTEN when the caller supplies
 *     its value as `RAILWAY_VAR_<NAME>` in this process's own environment; without
 *     one, drift is reported and left alone. A value that is already set is never
 *     overwritten.
 *   - ClickHouse retention: asserts the TTLs on xprem's Observe tables. Skipped
 *     (not failed) when no CLICKHOUSE_URL is available to this process, matching how
 *     scripts/mobile-ota-health-check.ts skips without a PostHog key.
 *
 * Secrets are never printed. Variables are reduced to set/absent/placeholder in
 * infra/railway/plan.ts before they reach any output path.
 *
 * Modes:
 *   (default)  Dry-run. Fetch live state, print the diff, exit non-zero if any drift
 *              exists (so CI can gate on it). Never mutates.
 *   --apply    Perform only the needed, non-blocked mutations. No-op when live
 *              matches desired.
 *
 * Usage:
 *   RAILWAY_TOKEN=... RAILWAY_PROJECT_ID=... vp run railway:apply
 *   RAILWAY_TOKEN=... RAILWAY_PROJECT_ID=... RAILWAY_VAR_CLICKHOUSE_URL=... \
 *     vp run railway:apply -- --apply
 *
 * Env:
 *   RAILWAY_TOKEN       (required) Railway API token. Same secret the deploy
 *                       workflow already uses against backboard.railway.com.
 *   RAILWAY_PROJECT_ID  (required) The project holding the OTA services.
 *   RAILWAY_VAR_<NAME>  (optional) Value for a declared variable, enabling --apply
 *                       to converge it. Never logged.
 *   CLICKHOUSE_URL      (optional) Enables the retention assertion. Read-only use.
 *
 * See docs/railway.md and infra/railway/config.ts.
 */

import { pathToFileURL } from 'node:url';
import { desiredRailwayState } from '../infra/railway/config';
import type { RailwayDesiredState } from '../infra/railway/config';
import { buildPlan, undeclaredServices, varKey } from '../infra/railway/plan';
import type { LiveService, LiveState, PlannedChange } from '../infra/railway/plan';

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

/** Prefix for caller-supplied variable values. `RAILWAY_VAR_CLICKHOUSE_URL` -> `CLICKHOUSE_URL`. */
const SUPPLIED_VAR_PREFIX = 'RAILWAY_VAR_';

export interface CliOptions {
  apply: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  let apply = false;
  let help = false;

  for (const argument of argv) {
    if (argument === '--') continue;
    else if (argument === '--apply') apply = true;
    else if (argument === '--dry-run') apply = false;
    else if (argument === '--help' || argument === '-h') help = true;
    // Reject typos loudly — a silently ignored --appply would dry-run when the
    // operator believed they applied.
    else throw new Error(`Unknown flag: ${argument} (see --help)`);
  }

  return { apply, help };
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
 * A value is only usable for a variable the config actually declares, so an
 * accidental `RAILWAY_VAR_JWT_SECRET` in the environment can never cause a write.
 */
export function suppliedVarKeys(desired: RailwayDesiredState, supplied: Map<string, string>): Set<string> {
  const keys = new Set<string>();
  for (const service of desired.services) {
    for (const required of service.requiredVars) {
      if (supplied.has(required.name)) keys.add(varKey(service.name, required.name));
    }
  }
  return keys;
}

interface GraphQLResponse<TData> {
  data?: TData;
  errors?: { message: string }[];
}

async function railwayRequest<TData>(token: string, query: string, variables: Record<string, unknown>): Promise<TData> {
  const response = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  const rawBody = await response.text();
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

const VARIABLE_UPSERT = `
  mutation VariableUpsert($input: VariableUpsertInput!) {
    variableUpsert(input: $input)
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
    services: data.project.services.edges.map((edge) => ({ id: edge.node.id, name: edge.node.name })),
  };
}

/**
 * Read the variables for every service we declare.
 *
 * Only declared services are queried: this tool has no reason to pull the secrets
 * of the Postgres service or anything else sharing the project.
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
    if (!live || declared.requiredVars.length === 0) continue;
    const data = await railwayRequest<{ variables: Record<string, string> }>(token, VARIABLES_QUERY, {
      projectId,
      environmentId,
      serviceId: live.id,
    });
    variables[declared.name] = data.variables ?? {};
  }

  return variables;
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

  const url = new URL(dsn);
  // The native-protocol DSN xprem uses names port 9000; the HTTP interface this
  // read-only query needs is 8123 on the same host.
  const httpPort = url.port === '9000' || url.port === '' ? '8123' : url.port;
  const endpoint = `${url.protocol === 'clickhouses:' ? 'https' : 'http'}://${url.hostname}:${httpPort}/`;
  const query =
    `SELECT name, ttl_expression FROM system.tables ` + `WHERE database = '${database}' FORMAT TabSeparated`;

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
    const [table, expression = ''] = line.split('\t');
    ttl[table] = expression;
  }
  return ttl;
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
      '  vp run railway:apply                 dry-run; exits non-zero on drift',
      '  vp run railway:apply -- --apply      converge what can be converged',
      '',
      'Required env: RAILWAY_TOKEN, RAILWAY_PROJECT_ID',
      'Optional env: RAILWAY_VAR_<NAME> (a value --apply may set), CLICKHOUSE_URL (TTL check)',
    ].join('\n'),
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
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
  if (supplied.size > 0) {
    // Names only, never values.
    console.log(`[railway-apply] Values supplied for: ${[...supplied.keys()].sort().join(', ')}`);
  }
  console.log('');

  const clickhouseTtl = await fetchClickHouseTtl(process.env.CLICKHOUSE_URL?.trim(), 'expo_observe');
  if (clickhouseTtl === null) {
    console.log('[railway-apply] Retention check skipped: no CLICKHOUSE_URL in this environment.');
  }

  const live: LiveState = {
    services: project.services,
    variables: await fetchVariables(token, projectId, project.environmentId, desired, project.services),
    clickhouseTtl,
  };

  for (const name of undeclaredServices(desired, live)) {
    console.log(`[railway-apply] note: service "${name}" is live but not declared here — left untouched.`);
  }

  const changes = buildPlan(desired, live, { suppliedVars: suppliedVarKeys(desired, supplied) });

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

  let blockedRemaining = 0;

  for (const change of changes) {
    if (change.blocked) {
      console.warn(`[railway-apply] SKIPPED (blocked): ${change.summary}`);
      blockedRemaining += 1;
      continue;
    }

    if (change.resource === 'env-var' && change.target) {
      const service = project.services.find((candidate) => candidate.name === change.target?.serviceName);
      const value = supplied.get(change.target.varName);
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
        },
      });
      console.log(`[railway-apply] applied: ${change.summary}`);
    } else {
      // Every other resource is report-only by construction; reaching here means a
      // new resource type was added to the plan without an apply path.
      throw new Error(`No apply path for resource "${change.resource}" — ${change.summary}`);
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
export { RAILWAY_API, SUPPLIED_VAR_PREFIX };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[railway-apply] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
