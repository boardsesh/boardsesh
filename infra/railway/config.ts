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
// value — which makes it non-secret by construction — or by name only, in which
// case this file asserts that it exists and is not still a placeholder. The value
// lives in Railway, and the apply script reads what it needs from its own
// environment — the same contract scripts/cloudflare-apply.ts uses for
// CLOUDFLARE_API_TOKEN.

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

/** The dedicated Postgres holding xprem's control plane — and the app's signing key. */
export const OTA_POSTGRES_SERVICE_NAME = 'Postgres';

/**
 * The xprem release currently deployed.
 *
 * This is the one place the deployed server version is written down. Before it
 * lived here it was prose in four files, kept honest by a self-expiring marker in
 * scripts/__tests__/eoas-version-parity.test.ts — a convention that existed only
 * because nothing in the repo could perform the dashboard action. Now the apply
 * script can, so the constant is the source of truth and the test compares against
 * it.
 *
 * Bumping this is an upgrade. scripts/ota-image-bump.ts opens that PR, and moves
 * EOAS_PACKAGE_SPEC (scripts/lib/eoas.ts) in the same commit.
 */
export const OTA_SERVER_VERSION = '3.1.2';

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
 * Image for the ClickHouse service. Pinned to the version xprem itself tests
 * against — docker-compose.yml and .github/workflows/push.yml in the xprem repo
 * both use `clickhouse/clickhouse-server:25.3`. Running a version xprem's goose
 * migrations have never been exercised on is an avoidable risk.
 */
export const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:25.3';

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
   * placeholder, never printed, never overwritten once set.
   */
  value?: string;
}

/** A variable that must NOT be set, because setting it changes how xprem behaves. */
export interface ForbiddenEnvVar {
  name: string;
  reason: string;
}

/** Railway's restart policy for a crashed deployment. */
export type RestartPolicyType = 'ALWAYS' | 'NEVER' | 'ON_FAILURE';

/** Deploy settings this tool applies. Every field here is safe and reversible. */
export interface DeploySettings {
  healthcheckPath: string;
  healthcheckTimeout: number;
  restartPolicyType: RestartPolicyType;
  restartPolicyMaxRetries: number;
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
 * correct. Variables without one are secrets: asserted present and non-placeholder,
 * never printed, never overwritten once set.
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
    reason: 'The Tigris bucket holding every published update. Empty at V3 green-field; never shared with V2.',
  },
  {
    name: 'AWS_REGION',
    value: 'auto',
    reason: 'Tigris is globally replicated and expects the literal "auto" rather than a region name.',
  },
  {
    name: 'AWS_BASE_ENDPOINT',
    value: 'https://t3.storage.dev',
    reason: 'The S3-compatible endpoint. Wrong value means publishes fail against the real AWS endpoints.',
  },
  {
    name: 'CACHE_MODE',
    value: 'local',
    reason: 'In-process cache, which is correct at one replica and would go inconsistent above it.',
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
];

/**
 * Services this repo knowingly does not manage.
 *
 * Recorded so that `undeclaredServices()` reports a service nobody has claimed —
 * which is a real event worth seeing — instead of the same five lines every night.
 * Nothing here is asserted or applied.
 */
export const INVENTORY_SERVICES: ServiceDesired[] = [
  {
    name: 'boardsesh-web',
    management: 'inventory',
    requiredVars: [],
    managedBy: 'railway.web.toml + .github/workflows/production-deploy.yml',
  },
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
    name: 'PostGIS - PROD',
    management: 'inventory',
    requiredVars: [],
    managedBy: "Railway's Postgres template; the application database, see docs/db-connectivity.md",
  },
  {
    name: 'Redis',
    management: 'inventory',
    requiredVars: [],
    managedBy: "Railway's Redis template; pub/sub for the backend",
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
        restartPolicyType: 'ON_FAILURE',
        restartPolicyMaxRetries: 5,
        // Matches the backend's railway.toml. Unlike the backend there is no
        // force-exit timer to stay above — xprem is upstream's Go binary and we do
        // not own its shutdown — so this is a plain safety net.
        drainingSeconds: 15,
      },
      domains: [{ domain: 'updates.boardsesh.com', targetPort: OTA_CONTAINER_PORT }],
      // CACHE_MODE=local is only correct at one replica: a second would serve from
      // its own cache and answer manifest checks inconsistently.
      expectedScale: { numReplicas: 1, region: 'us-west2' },
      // The checklist docs/mobile-ota-updates.md already prescribes after any bump.
      verify: { baseUrl: OTA_BASE_URL, paths: [OTA_HEALTHCHECK_PATH, OTA_READINESS_PATH] },
      requiredVars: OTA_REQUIRED_VARS,
      forbiddenVars: OTA_FORBIDDEN_VARS,
    },
    {
      name: CLICKHOUSE_SERVICE_NAME,
      management: 'managed',
      image: CLICKHOUSE_IMAGE,
      volume: { mountPath: CLICKHOUSE_VOLUME_MOUNT_PATH, name: CLICKHOUSE_VOLUME_NAME },
      expectedScale: { numReplicas: 1, region: 'us-west2' },
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
    ...INVENTORY_SERVICES,
  ],
  clickhouseRetention: CLICKHOUSE_RETENTION,
  clickhouseVolumeUsageLimitPercent: CLICKHOUSE_VOLUME_USAGE_LIMIT_PERCENT,
};
