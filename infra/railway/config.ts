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
// 2. Enabling xprem's Observe feature adds a ClickHouse service and one env var
//    (`CLICKHOUSE_URL`) whose absence silently disables telemetry and whose
//    *unreachability at boot* is a `log.Fatalf` that takes the update server down.
//    That is worth a CI check rather than a runbook step.
//
// The Cloudflare tool next door (infra/cloudflare/) is the model: typed desired
// state here, pure diffing in ./plan.ts, all I/O in scripts/railway-apply.ts.
//
// SECRET VALUES NEVER APPEAR IN THIS FILE. It declares that a variable must exist
// and must not still be a placeholder. The value lives in Railway, and the apply
// script reads what it needs from its own environment — the same contract
// scripts/cloudflare-apply.ts uses for CLOUDFLARE_API_TOKEN.

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

/**
 * Image for the ClickHouse service. Pinned to the version xprem itself tests
 * against — docker-compose.yml and .github/workflows/push.yml in the xprem repo
 * both use `clickhouse/clickhouse-server:25.3`. Running a version xprem's goose
 * migrations have never been exercised on is an avoidable risk.
 */
export const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:25.3';

/** ClickHouse's data directory. A service without a volume here loses telemetry on redeploy. */
export const CLICKHOUSE_VOLUME_MOUNT_PATH = '/var/lib/clickhouse';

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
 * Borrowed deliberately from xprem's own CLI, which uses the identical pattern to
 * flag the identical mistake (PLACEHOLDER_PATTERN in
 * apps/eoas/src/lib/serverConfig/envCatalog.ts). A placeholder passes a
 * "is the variable set?" check and fails at boot, so it is worth its own state.
 */
export const PLACEHOLDER_PATTERN = /<[^>]+>/;

/**
 * How much of a service this repo owns.
 *
 * `assert-only` — the service already exists and is configured elsewhere. We check
 * the variables we care about and touch nothing else. This is deliberately the
 * setting for `boardsesh-ota-v3`: it carries storage credentials, code-signing
 * config and the JWT secret that this tool has no business reasoning about.
 *
 * `report-only` — we know the service should exist and what shape it should have,
 * but creating it is left to a human. See CREATION_IS_NOT_AUTOMATED below.
 */
export type ServiceManagement = 'assert-only' | 'report-only';

/**
 * Creating a stateful Railway service is NOT automated by this tool, on purpose.
 *
 * A ClickHouse service is only correct with a persistent volume attached, and a
 * service created without one looks healthy while losing every row on each
 * redeploy. Getting that wrong from a script — or worse, creating a second service
 * because a name lookup missed — is a failure mode with no cheap undo, which is the
 * same reason the Cloudflare tool reports a zone-wide SSL change instead of
 * applying it.
 *
 * So: this tool tells you precisely what is missing and what to create. It applies
 * variables, which are safe and idempotent. Widening it to `serviceCreate` +
 * `volumeCreate` is a deliberate follow-up, not an oversight.
 */
export const CREATION_IS_NOT_AUTOMATED = true;

export interface RequiredEnvVar {
  /** Variable name. The value is never declared here. */
  name: string;
  /** Why the service needs it — printed in the plan so drift is self-explaining. */
  reason: string;
}

export interface ServiceDesired {
  name: string;
  management: ServiceManagement;
  requiredVars: RequiredEnvVar[];
  /** Only meaningful for a report-only service we describe but do not create. */
  expected?: {
    image: string;
    volumeMountPath: string;
  };
}

/** One table's retention rule, asserted against ClickHouse rather than Railway. */
export interface TableRetentionDesired {
  table: string;
  /** The DateTime column the TTL is measured from. */
  column: string;
  ttlDays: number;
  reason: string;
}

export interface RailwayDesiredState {
  environmentName: string;
  services: ServiceDesired[];
  clickhouseRetention: TableRetentionDesired[];
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
];

export const desiredRailwayState: RailwayDesiredState = {
  environmentName: RAILWAY_ENVIRONMENT_NAME,
  services: [
    {
      name: OTA_SERVICE_NAME,
      management: 'assert-only',
      requiredVars: [
        {
          name: 'CLICKHOUSE_URL',
          reason:
            'Enables xprem Observe. Unset means telemetry ingest is silently dropped and the ' +
            'dashboard renders the "turn on telemetry" placeholder instead of metrics.',
        },
      ],
    },
    {
      name: CLICKHOUSE_SERVICE_NAME,
      management: 'report-only',
      requiredVars: [],
      expected: {
        image: CLICKHOUSE_IMAGE,
        volumeMountPath: CLICKHOUSE_VOLUME_MOUNT_PATH,
      },
    },
  ],
  clickhouseRetention: CLICKHOUSE_RETENTION,
};
