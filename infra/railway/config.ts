/// <reference types="node" />

// Declarative desired-state for the Railway project that runs the self-hosted xprem
// OTA server. This is plain typed data — no side effects, no API calls.
// scripts/railway-apply.ts reads it, diffs it against the live project, and (only
// with --apply) converges the delta.
//
// Why this exists:
//
// 1. `boardsesh-ota-v3` is the Railway service every production and TestFlight
//    binary talks to for OTA manifests (docs/mobile-ota-updates.md). Its
//    configuration was set by hand in the Railway dashboard, so nothing in the repo
//    records what it is supposed to look like and nothing notices when it drifts.
//
// 2. Upgrading the server used to be a dashboard edit, tracked in prose. The image
//    tag now lives here (OTA_SERVER_VERSION), so an upgrade is a one-line PR that
//    CI applies and verifies.
//
// 3. Enabling xprem's Observe feature adds a ClickHouse service and one env var
//    (`CLICKHOUSE_URL`) whose absence silently disables telemetry and whose
//    *unreachability at boot* is a `log.Fatalf` that takes the update server down.
//    That is worth a CI check rather than a runbook step.
//
// The Cloudflare tool next door (infra/cloudflare/) is the model: typed desired
// state here, pure diffing in ./plan.ts, all I/O in scripts/railway-apply.ts.
//
// SECRET VALUES NEVER APPEAR IN THIS FILE. A variable is declared either with a
// value — which makes it repo-managed and non-secret — or by name only, in which
// case this file asserts that it exists and is not still a placeholder. Unmanaged
// values live in Railway, and the apply script reads missing replacements from its
// own environment.

/**
 * The Railway environment these services live in. Railway projects are
 * environment-scoped and every service/variable read is keyed on one, so this is
 * part of the address, not a preference.
 */
export const RAILWAY_ENVIRONMENT_NAME = 'production';

/** The xprem OTA server. Named in docs/mobile-ota-updates.md; matched by name, not id. */
export const OTA_SERVICE_NAME = 'boardsesh-ota-v3';

/** The ClickHouse service backing xprem's Observe feature. */
export const CLICKHOUSE_SERVICE_NAME = 'boardsesh-ota-clickhouse';

/** The public www service. Its variable assertions must survive OTA config changes. */
export const WEB_SERVICE_NAME = 'boardsesh-web';

/**
 * The production PostgreSQL 18 primary. Declared assert-only and for its TLS
 * variables alone: its image digest, volume and networking are managed by the
 * reviewed publish flow in docs/postgres-image-publishing.md, not from here.
 */
export const POSTGRES_PRIMARY_SERVICE_NAME = 'PostGIS - PG18';

/** The only public origin that can safely issue Boardsesh's cross-subdomain session cookies. */
export const CANONICAL_WEB_ORIGIN = 'https://www.boardsesh.com';

/** The dedicated Postgres holding xprem's control plane — and the app's signing key. */
export const OTA_POSTGRES_SERVICE_NAME = 'Postgres';

/**
 * The xprem release declared for deployment.
 *
 * This is the one place the desired server version is written down. Before it
 * lived here it was prose in four files, kept honest by a self-expiring marker in
 * scripts/__tests__/eoas-version-parity.test.ts — a convention that existed only
 * because nothing in the repo could perform the dashboard action. Now the apply
 * script can, so the constant is the source of truth and the test compares against
 * it. The declaration alone does not prove that a deployment has succeeded;
 * railway-apply reads the configured and running images before reporting sync.
 *
 * Bumping this is an upgrade. scripts/ota-image-bump.ts opens that PR, and moves
 * EOAS_PACKAGE_SPEC (scripts/lib/eoas.ts) in the same commit.
 */
export const OTA_SERVER_VERSION = '3.2.4';

/**
 * The repository path Railway pulls from.
 *
 * Deliberately the PRE-RENAME name. Upstream renamed expo-open-ota → xprem at
 * v3.1.0 and still publishes both names for the same release, and the Railway
 * service was created against the old path. So a service that does not say
 * `xprem` is not a sign the server is behind — see docs/mobile-ota-updates.md.
 */
export const OTA_IMAGE_REPOSITORY = 'ghcr.io/mercuretechnologies/expo-open-ota';

/** The exact image the OTA service must run. */
export const OTA_IMAGE = `${OTA_IMAGE_REPOSITORY}:v${OTA_SERVER_VERSION}`;

/** Public origin of the OTA server. Also the value of its own BASE_URL. */
export const OTA_BASE_URL = 'https://updates.boardsesh.com';

/** The port xprem listens on inside the container, and the custom domain's target. */
export const OTA_CONTAINER_PORT = 8080;

/**
 * xprem's liveness endpoint, used as Railway's healthcheck.
 *
 * `/ready` is deliberately NOT the healthcheck. It is the right post-deploy probe,
 * but as a gate it would let a ClickHouse blip block an otherwise good OTA
 * deployment — and since xprem exits at boot when ClickHouse is unreachable, that
 * turns one dependency's bad minute into a stuck deploy.
 */
export const OTA_HEALTHCHECK_PATH = '/hc';

/** xprem's readiness endpoint. Probed after a deploy, never used as the gate. */
export const OTA_READINESS_PATH = '/ready';

/**
 * Image for the ClickHouse service. The base is still `clickhouse/clickhouse-server:25.3` —
 * the version xprem itself tests against (docker-compose.yml and .github/workflows/push.yml
 * in the xprem repo both use it; running a version xprem's goose migrations have never been
 * exercised on is an avoidable risk) — now wrapped by `ghcr.io/boardsesh/boardsesh-clickhouse`
 * (built from `docker/clickhouse/Dockerfile`), which layers lean `config.d`/`users.d`
 * overrides on top to cap memory and turn off the system logs. It is published by
 * `.github/workflows/clickhouse-image.yml` on dispatch. Changing this digest is how a new
 * image is rolled out (docs/railway.md, "Rolling out a new ClickHouse image"):
 * railway-apply compares it against both the configured and the serving image, deploys
 * a change only with --allow-image-change, and then probes the OTA server's readiness,
 * because xprem is the thing that has to reach ClickHouse.
 */
export const CLICKHOUSE_IMAGE =
  'ghcr.io/boardsesh/boardsesh-clickhouse@sha256:80d3d4c0dfacbd845476eea56ca239a3d658e868e01389ed264e1a9ecf56f6fd';

/** ClickHouse's data directory. A service without a volume here loses telemetry on redeploy. */
export const CLICKHOUSE_VOLUME_MOUNT_PATH = '/var/lib/clickhouse';

/** Railway's name for that volume, used to read its utilisation back. */
export const CLICKHOUSE_VOLUME_NAME = 'boardsesh-ota-clickhouse-data';

/** Postgres's data directory on the OTA control-plane database. */
export const OTA_POSTGRES_VOLUME_MOUNT_PATH = '/var/lib/postgresql/data';

/**
 * The dedicated database xprem writes Observe telemetry into.
 *
 * It must be dedicated and it must be named in the DSN: xprem refuses to boot on a
 * `CLICKHOUSE_URL` with no database segment (NewClickHouseEngine in
 * internal/database/clickhouse/clickhouse.go).
 */
export const CLICKHOUSE_DATABASE = 'expo_observe';

/**
 * Matches a value that is structurally present but was never filled in — the shape
 * `npx eoas server:init` writes when you enable Observe without pasting a DSN
 * (`CLICKHOUSE_URL=<clickhouse://user:password@host:9000/xprem>`).
 *
 * Borrowed from xprem's own CLI, which flags the identical mistake
 * (PLACEHOLDER_PATTERN in apps/eoas/src/lib/serverConfig/envCatalog.ts). A
 * placeholder passes a "is the variable set?" check and fails at boot, so it is
 * worth its own state.
 *
 * ANCHORED, unlike xprem's. An unanchored pattern matches any value merely
 * CONTAINING a bracketed run — and `ADMIN_PASSWORD` is the one variable whose
 * documented policy requires a symbol, so `hunter<2>!Ab` is a plausible real
 * password. Misreading a live secret as a placeholder is not cosmetic: it makes
 * the variable convergeable, so a supplied value would overwrite a working one,
 * breaking this tool's own rule that a set secret is never clobbered. What
 * `eoas server:init` actually writes is a whole-value placeholder, which anchoring
 * still catches.
 */
export const PLACEHOLDER_PATTERN = /^<[^>]+>$/;

/**
 * How much of a service this repo owns.
 *
 * `managed` — the image, deploy settings, custom domains and declared variables
 * are ours, and `--apply` converges them. Creating the service is still not
 * automated; see CREATION_IS_NOT_AUTOMATED.
 *
 * `assert-only` — the service exists and something else decides its shape. We
 * check the variables we care about and touch nothing else.
 *
 * `report-only` — we know the service should exist and what shape it should have,
 * but creating it is left to a human.
 *
 * `inventory` — the service is somebody else's on purpose. Recorded here only so
 * that `undeclaredServices()` reports a genuinely NEW service rather than the five
 * we already know about. Nothing is asserted and nothing is applied.
 */
export type ServiceManagement = 'managed' | 'assert-only' | 'report-only' | 'inventory';

/**
 * Creating a Railway service is NOT automated by this tool, on purpose.
 *
 * A ClickHouse service is only correct with a persistent volume attached, and a
 * service created without one looks healthy while losing every row on each
 * redeploy. Getting that wrong from a script — or worse, creating a second service
 * because a name lookup missed — is a failure mode with no cheap undo, which is the
 * same reason the Cloudflare tool reports a zone-wide SSL change instead of
 * applying it.
 *
 * Changing an EXISTING service is a different risk and is automated: it is
 * reversible (change the constant back), Railway keeps the deployment history, and
 * the apply path verifies the result and rolls back on its own when the new
 * deployment does not answer.
 */
export const CREATION_IS_NOT_AUTOMATED = true;

export interface RequiredEnvVar {
  /** Variable name. */
  name: string;
  /** Why the service needs it — printed in the plan so drift is self-explaining. */
  reason: string;
  /**
   * The exact value this repo owns, for non-secret configuration.
   *
   * Declaring a value here is what makes a variable non-secret: anything with a
   * value in this file is, by construction, safe to print in a plan line. Omit it
   * and the variable is presence-only — asserted to exist and not be a
   * placeholder, never printed, never overwritten once set. Most presence-only
   * values are secrets; AWS_BASE_ENDPOINT is intentionally provider-managed.
   */
  value?: string;
}

/** A variable that must NOT be set, because setting it changes how xprem behaves. */
export interface ForbiddenEnvVar {
  name: string;
  reason: string;
}

/** A variable which may be absent, but must use one of these safe values when present. */
export interface OptionalConstrainedEnvVar {
  name: string;
  allowedValues: readonly string[];
  reason: string;
}

/**
 * A variable which must be present AND hold one of these public values. Absence is
 * drift too: the remediation is always "set it", never "remove it".
 */
export interface RequiredConstrainedEnvVar {
  name: string;
  /** Public, non-secret values the variable must hold. */
  allowedValues: readonly string[];
  reason: string;
}

/** At least one variable in the group must contain the public expected value. */
export interface RequiredOneOfEnvVars {
  names: readonly string[];
  expectedValue: string;
  reason: string;
}

/** Railway's restart policy for a crashed deployment. */
export type RestartPolicyType = 'ALWAYS' | 'NEVER' | 'ON_FAILURE';

/** Deploy settings this tool applies. Every field here is safe and reversible. */
export interface DeploySettings {
  healthcheckPath: string;
  healthcheckTimeout: number;
  restartPolicyType: RestartPolicyType;
  /**
   * Restart cap under ON_FAILURE. Omit it under ALWAYS: the planner neither
   * compares nor writes it then, because it has no effect and Railway's stored
   * value for it is not documented.
   */
  restartPolicyMaxRetries?: number;
  /**
   * The SIGTERM-to-SIGKILL window.
   *
   * Railway defaults to 0s, so both signals arrive together and an in-flight
   * manifest or asset fetch is severed mid-response on every redeploy — the same
   * root cause railway.toml's `drainingSeconds` fixes for web and backend
   * (docs/production-deploy.md). This service has no railway.toml to carry it:
   * Config-as-Code is read from the service's *source repository* at deploy time,
   * and this service's source is a third-party image with no repo attached.
   *
   * Railway also exposes this as a `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` variable,
   * which would have worked — but the typed field is the better door. It keeps the
   * variable layer's "never overwrite a value that is already set" rule
   * unqualified, which is exactly the rule that protects a live DSN.
   */
  drainingSeconds: number;
}

/**
 * Scale settings this tool reads and reports but never applies.
 *
 * Replica count and region are capacity and data-locality decisions with a cost
 * attached, and moving a region relocates a running service. Worth noticing when
 * they change; not worth a script changing them.
 */
export interface ExpectedScale {
  numReplicas: number;
  region: string;
}

/** A custom domain the service must answer on. */
export interface DesiredDomain {
  domain: string;
  targetPort: number;
}

export interface ServiceDesired {
  name: string;
  management: ServiceManagement;
  requiredVars: RequiredEnvVar[];
  optionalConstrainedVars?: OptionalConstrainedEnvVar[];
  requiredConstrainedVars?: RequiredConstrainedEnvVar[];
  requiredOneOfVars?: RequiredOneOfEnvVars[];
  /** Variables that must stay unset. Reported, never deleted. */
  forbiddenVars?: ForbiddenEnvVar[];
  /** The exact image the service must run. Applied for `managed`. */
  image?: string;
  /** Deploy settings to converge. Applied for `managed`. */
  deploy?: DeploySettings;
  /** Custom domains. A missing one is created; an extra one is only reported. */
  domains?: DesiredDomain[];
  /**
   * The volume the service must mount, and where. Asserted, never created.
   *
   * `name` is only needed where the tool also reads the volume's utilisation back
   * (ClickHouse). Where it is absent, the mount path alone is asserted — which is
   * the thing that matters: a service whose volume came unmounted looks perfectly
   * healthy and loses its data on the next redeploy.
   */
  volume?: { mountPath: string; name?: string };
  /** Read and reported, never applied. */
  expectedScale?: ExpectedScale;
  /**
   * Endpoints probed after this tool rolls a deployment.
   *
   * A Railway deployment reaching SUCCESS means the container started and passed
   * the healthcheck. It does not mean the server this repo depends on is answering
   * the routes the app needs. Probing them is what turns "deployed" into
   * "working", and a failed probe is what triggers the automatic rollback.
   */
  verify?: { baseUrl: string; paths: string[] };
  /** For `inventory` services: who actually configures this one. */
  managedBy?: string;
}

/** One table's retention rule, asserted against ClickHouse rather than Railway. */
export interface TableRetentionDesired {
  table: string;
  /** The DateTime column the TTL is measured from. */
  column: string;
  ttlDays: number;
  reason: string;
}

/**
 * Volume headroom for the ClickHouse service.
 *
 * A full volume is the failure that actually bites: ClickHouse stops accepting
 * writes, and because xprem calls log.Fatalf when ClickHouse is unreachable at
 * boot, the next OTA restart would then fail to come up at all. So this is
 * watched, not just the row counts.
 *
 * Railway's metrics API is reachable from CI even though ClickHouse itself is
 * not (its DSN host resolves only inside the private network), which is why this
 * assertion can run nightly while the retention one cannot.
 *
 * 80% of a 50 GB volume leaves ~10 GB of runway — weeks of headroom at any
 * growth rate this workload has shown, and enough warning to resize or trim.
 */
export const CLICKHOUSE_VOLUME_USAGE_LIMIT_PERCENT = 80;

export interface RailwayDesiredState {
  environmentName: string;
  services: ServiceDesired[];
  clickhouseRetention: TableRetentionDesired[];
  /** Fail the run when the ClickHouse volume passes this much of its capacity. */
  clickhouseVolumeUsageLimitPercent: number;
}

/**
 * Retention for the two Observe fact tables.
 *
 * xprem's ClickHouse migrations ship NO TTL on any table — verified across both
 * files in internal/database/clickhouse/migrations/. Left alone these grow without
 * bound, and the growth is invisible until a volume fills.
 *
 * Logs get the shorter window because their bodies and attribute blobs dominate the
 * bytes, while the metrics are narrow numeric rows that compress well and are the
 * ones worth comparing across releases months apart.
 *
 * These tables are created and migrated by xprem via goose, not by us, so a server
 * upgrade can silently drop a TTL we set out of band. That is exactly why this is
 * asserted on every run instead of being a one-time runbook step. The durable fix is
 * a retention knob upstream in xprem; until that exists, this check is the guard.
 */
export const CLICKHOUSE_RETENTION: TableRetentionDesired[] = [
  {
    table: 'observe_metrics',
    column: 'timestamp',
    ttlDays: 90,
    reason: 'Startup/navigation timings, compared across releases over a long window.',
  },
  {
    table: 'observe_logs',
    column: 'timestamp',
    ttlDays: 30,
    reason: 'Event and error bodies; the widest rows, and stale ones are rarely read.',
  },
  // The three below fill from ordinary manifest check-ins, with no app-side
  // telemetry involved, so they are the ones actually accumulating today.
  {
    table: 'update_health_snapshots',
    column: 'bucket',
    ttlDays: 90,
    // ee/observe/health_history.go snapshots every current (update, role) on a
    // one-minute ticker, so this grows ~288k rows/day independently of how many
    // climbers are using the app — the per-PR pr-* branches drive it. Nothing
    // reads minute resolution a quarter later; the dashboard plots rollouts over
    // hours and days.
    reason: 'One-minute rollout samples: the highest-volume table, and useless at minute grain once old.',
  },
  {
    table: 'update_health_segment_snapshots',
    column: 'bucket',
    ttlDays: 90,
    // Coarser in time than the table above (a fixed five-minute bucket) but far
    // wider: eight dimensions, each fanning out over its own segment values.
    reason: 'Five-minute samples split eight ways by dimension, so width replaces the cadence.',
  },
  {
    table: 'device_health_events',
    column: 'occurred_at',
    ttlDays: 180,
    // Only written when a device genuinely changes update (first_seen /
    // switched / failure), so this is the smallest of the three and the one
    // worth keeping longest: it is the raw adoption record the snapshots
    // summarise.
    reason: 'Raw per-device adoption events: the lowest volume here and the record the rest is derived from.',
  },
];

/**
 * The variables xprem must NOT see in control-plane mode.
 *
 * These are not tidiness. In control-plane mode the app and its signing keypair
 * are created in the dashboard and the private key is generated in Postgres and
 * sealed under DB_KEYS_MASTER_KEY_B64. Handing xprem an explicit keypair or a
 * different key-storage mode switches it off that path — and the private key that
 * signs every OTA manifest exists nowhere else. Reported, never deleted.
 */
export const OTA_FORBIDDEN_VARS: ForbiddenEnvVar[] = [
  {
    name: 'PRIVATE_EXPO_KEY_B64',
    reason: 'Control-plane generates and seals the signing key in Postgres. Setting this overrides it.',
  },
  {
    name: 'PUBLIC_EXPO_KEY_B64',
    reason: 'Pairs with PRIVATE_EXPO_KEY_B64; the cert is exported from the dashboard instead.',
  },
  {
    name: 'KEYS_STORAGE_TYPE',
    reason: 'Key storage is the database, chosen when the app was created. Changing it strands the sealed key.',
  },
  {
    name: 'EXPO_ACCESS_TOKEN',
    reason: 'A V2/stateless setting. Control-plane authenticates publishes with app-scoped eoo_ keys.',
  },
  {
    name: 'EXPO_APP_ID',
    reason: 'A V2/stateless setting. V3 routes on the expo-app-id request header the binary sends.',
  },
];

/**
 * xprem's environment contract, from the runbook in scripts/mobile-ota-setup.ts.
 *
 * Variables carrying a `value` are configuration this repo owns and `--apply` will
 * correct. Variables without one are presence-only: asserted present and
 * non-placeholder, never printed, never overwritten once set.
 */
export const OTA_REQUIRED_VARS: RequiredEnvVar[] = [
  {
    name: 'BASE_URL',
    value: OTA_BASE_URL,
    reason: 'The origin xprem signs manifests and builds asset URLs against.',
  },
  {
    name: 'STORAGE_MODE',
    value: 's3',
    reason: 'Updates and assets live in the S3-compatible bucket, not on the container filesystem.',
  },
  {
    name: 'S3_BUCKET_NAME',
    value: 'boardsesh-ota-v3',
    reason: 'The dedicated S3-compatible bucket holding every published update; never shared with V2.',
  },
  {
    name: 'AWS_REGION',
    value: 'auto',
    reason: 'The configured S3-compatible backend uses its automatic region selector.',
  },
  {
    name: 'AWS_BASE_ENDPOINT',
    reason:
      'The live S3-compatible endpoint. Presence-only so a provider migration cannot be overwritten by stale config.',
  },
  {
    name: 'USE_DASHBOARD',
    value: 'true',
    reason: 'Serves /dashboard, where channels are mapped, API keys minted and the cert exported.',
  },
  {
    name: 'PROMETHEUS_ENABLED',
    value: 'true',
    reason: 'Gates /metrics. Public and unauthenticated when on, which is the accepted trade here.',
  },
  {
    name: 'ADMIN_EMAIL',
    value: 'admin@boardsesh.com',
    reason: 'The dashboard login. Treated as production-release access: it can remap channels and roll out.',
  },
  {
    name: 'ADMIN_PASSWORD',
    reason:
      'Dashboard login. Must satisfy the xprem password policy (>=8 chars, mixed case, digit, ' +
      'symbol) or first boot crash-loops.',
  },
  {
    name: 'JWT_SECRET',
    reason: 'Signs dashboard sessions. Rotating it logs everyone out; leaking it grants release access.',
  },
  {
    name: 'DB_URL',
    reason: 'The control-plane Postgres. Holds the app row and the sealed private signing key.',
  },
  {
    name: 'DB_KEYS_MASTER_KEY_B64',
    reason:
      'Unseals the signing key in Postgres. Losing it alongside the backups makes the entire V3 fleet ' +
      'unsignable — no OTA could ever be published for those binaries again.',
  },
  {
    name: 'AWS_ACCESS_KEY_ID',
    reason: 'Bucket credential. Scoped to the OTA bucket only.',
  },
  {
    name: 'AWS_SECRET_ACCESS_KEY',
    reason: 'Bucket credential. Scoped to the OTA bucket only.',
  },
  {
    name: 'CLICKHOUSE_URL',
    reason:
      'Enables xprem Observe. Unset means telemetry ingest is silently dropped and the ' +
      'dashboard renders the "turn on telemetry" placeholder instead of metrics.',
  },
  // The three Redis connection variables below, plus CACHE_MODE and
  // CACHE_KEY_PREFIX in the OTA service's requiredConstrainedVars, move xprem's manifest/asset
  // cache out of the Go heap and into the project's shared Railway Redis.
  // Rollback lives in docs/railway-cost-reduction.md ("OTA server Redis
  // cache, September 26").
  {
    name: 'REDIS_HOST',
    reason:
      'Private-network host of the shared Railway Redis (${{Redis.REDISHOST}}). xprem dials ' +
      'REDIS_HOST:REDIS_PORT and panics when the first connection check fails, so without it ' +
      'the server cannot serve updates.',
  },
  {
    name: 'REDIS_PORT',
    reason:
      'Port of the shared Railway Redis (${{Redis.REDISPORT}}). xprem has no default ' +
      'for it: an empty value makes the address "host:" and the connection check panics.',
  },
  {
    name: 'REDIS_PASSWORD',
    reason:
      'Auth for the shared Railway Redis (${{Redis.REDISPASSWORD}}). Railway Redis requires ' +
      'a password, so without it the connection check fails with NOAUTH and xprem panics.',
  },
];

/**
 * Services this repo knowingly does not manage.
 *
 * Recorded so that `undeclaredServices()` reports a service nobody has claimed —
 * which is a real event worth seeing — instead of the same three lines every night.
 * Nothing here is asserted or applied.
 */
export const INVENTORY_SERVICES: ServiceDesired[] = [
  {
    name: 'boardsesh-backend',
    management: 'inventory',
    requiredVars: [],
    managedBy: 'railway.toml + .github/workflows/production-deploy.yml',
  },
  {
    name: 'boardsesh-scheduler',
    management: 'inventory',
    requiredVars: [],
    managedBy: 'the Railway dashboard; see docs/scheduler.md',
  },
  {
    name: 'Redis',
    management: 'inventory',
    requiredVars: [],
    managedBy: "Railway's Redis template; backend pub/sub and the OTA server's cache (REDIS_* on boardsesh-ota-v3)",
  },
];

export const desiredRailwayState: RailwayDesiredState = {
  environmentName: RAILWAY_ENVIRONMENT_NAME,
  services: [
    {
      name: OTA_SERVICE_NAME,
      management: 'managed',
      image: OTA_IMAGE,
      deploy: {
        healthcheckPath: OTA_HEALTHCHECK_PATH,
        // Railway's own default is 300s. 100s matches railway.toml and
        // railway.web.toml, and is far above a cold xprem boot.
        healthcheckTimeout: 100,
        // ALWAYS, not ON_FAILURE: with CACHE_MODE=redis xprem panics when its first
        // Redis ping fails (most likely during Railway's weekend Redis auto-update),
        // and a capped retry count would leave the OTA server down once it ran out.
        // ALWAYS keeps it retrying until Redis answers. No retry count is declared:
        // it has no effect under ALWAYS, so the planner neither compares nor writes it.
        restartPolicyType: 'ALWAYS',
        // Matches the backend's railway.toml. Unlike the backend there is no
        // force-exit timer to stay above — xprem is upstream's Go binary and we do
        // not own its shutdown — so this is a plain safety net.
        drainingSeconds: 15,
      },
      domains: [{ domain: 'updates.boardsesh.com', targetPort: OTA_CONTAINER_PORT }],
      // One replica. The cache is shared Redis now, so a second replica would no longer
      // disagree on manifests, but it doubles cost and nothing needs the capacity.
      // Reported, never applied: replica count is a cost decision.
      expectedScale: { numReplicas: 1, region: 'us-west2' },
      // The checklist docs/mobile-ota-updates.md already prescribes after any bump.
      verify: { baseUrl: OTA_BASE_URL, paths: [OTA_HEALTHCHECK_PATH, OTA_READINESS_PATH] },
      requiredVars: OTA_REQUIRED_VARS,
      forbiddenVars: OTA_FORBIDDEN_VARS,
      requiredConstrainedVars: [
        {
          name: 'CACHE_MODE',
          allowedValues: ['redis'],
          reason:
            'xprem falls back to CACHE_MODE=local when this is unset, and the local cache has no ' +
            'size bound or eviction: it reached a 1.7 GB live Go heap (2.3M objects) after 21 days. ' +
            'The server keeps serving, so nothing fails except the memory bill. A rollback to local ' +
            'is a deliberate, temporary step; the drift check reports it until reverted.',
        },
        {
          name: 'CACHE_KEY_PREFIX',
          allowedValues: ['boardsesh-ota'],
          reason:
            'Any other prefix, including xprem\'s default "expoopenota" when unset, moves every ' +
            'cached manifest, lock and rate-limit counter to a different key namespace without any ' +
            "error. Pinning it keeps the keys stable and easy to tell apart from the backend's keys " +
            'in the same Redis.',
        },
      ],
    },
    {
      name: CLICKHOUSE_SERVICE_NAME,
      management: 'managed',
      image: CLICKHOUSE_IMAGE,
      volume: { mountPath: CLICKHOUSE_VOLUME_MOUNT_PATH, name: CLICKHOUSE_VOLUME_NAME },
      expectedScale: { numReplicas: 1, region: 'us-west2' },
      // Probes the OTA server, not ClickHouse. ClickHouse has no public endpoint,
      // and xprem is the client that has to reach it: a ClickHouse rollout that
      // reaches SUCCESS but leaves xprem unable to connect fails /ready here and
      // rolls ClickHouse back. The OTA server itself is not redeployed.
      verify: { baseUrl: OTA_BASE_URL, paths: [OTA_HEALTHCHECK_PATH, OTA_READINESS_PATH] },
      requiredVars: [],
    },
    {
      // Deliberately NOT `managed`. This runs Railway's own Postgres template with
      // their vulnerability auto-updates (tagMode: sha), so pinning an image here
      // would fight Railway's patching of a database that holds the only copy of
      // the app's private signing key. Assert the volume; leave the image alone.
      name: OTA_POSTGRES_SERVICE_NAME,
      management: 'assert-only',
      volume: { mountPath: OTA_POSTGRES_VOLUME_MOUNT_PATH },
      requiredVars: [],
    },
    {
      name: POSTGRES_PRIMARY_SERVICE_NAME,
      management: 'assert-only',
      requiredVars: [
        {
          name: 'PG_TLS_SERVER_CERT',
          reason:
            'The primary serves this certificate. Without it the image falls back to the base ' +
            "image's snakeoil certificate, whose private key is published in a public Docker Hub " +
            'layer, and the homelab DR standby refuses to replicate because it verifies the chain ' +
            'and the hostname.',
        },
        {
          name: 'PG_TLS_SERVER_KEY',
          reason:
            'The matching private key. It cannot live in the image, which is public on GHCR, and ' +
            'it must not live under PGDATA, which pg_basebackup copies wholesale onto the standby ' +
            'and into every WAL-G backup. The entrypoint writes it to the volume outside PGDATA.',
        },
      ],
    },
    {
      name: WEB_SERVICE_NAME,
      management: 'assert-only',
      requiredVars: [
        {
          name: 'SMTP_USER',
          reason: 'Required to send password-reset and verification emails for credential accounts.',
        },
        {
          name: 'SMTP_PASSWORD',
          reason: 'Required to authenticate the SMTP transport for credential-account emails.',
        },
      ],
      optionalConstrainedVars: [
        {
          name: 'BOARDSESH_WEB',
          allowedValues: ['1'],
          reason: 'The Docker image enables the www-to-app auth bridge; any other dashboard override disables it.',
        },
      ],
      requiredOneOfVars: [
        {
          names: ['NEXTAUTH_URL', 'BASE_URL'],
          expectedValue: CANONICAL_WEB_ORIGIN,
          reason:
            'At least one canonical origin is required for secure cross-subdomain session cookies and email links.',
        },
      ],
    },
    ...INVENTORY_SERVICES,
  ],
  clickhouseRetention: CLICKHOUSE_RETENTION,
  clickhouseVolumeUsageLimitPercent: CLICKHOUSE_VOLUME_USAGE_LIMIT_PERCENT,
};
