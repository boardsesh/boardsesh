import { bucket, defineRailway, image, postgres, preserve, project, redis, service, volume } from 'railway/iac';

export default defineRailway(() => {
  const Postgres = postgres('Postgres', { region: 'us-west2' });
  Postgres.networking = { privateNetworkEndpoint: 'postgres', tcpProxies: { '5432': {} } };
  const Redis = redis('Redis', { region: 'us-west2' });
  Redis.deploy = {
    limitOverride: { containers: { cpu: 6, memoryBytes: 8000000000 } },
    startCommand:
      '/bin/sh -c "rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH"',
  };
  Redis.networking = { privateNetworkEndpoint: 'redis', tcpProxies: { '6379': {} } };
  const PostGISPG18 = postgres('PostGIS - PG18', { region: 'us-west2' });
  // Keep this existing Railway-managed database's current source unset.
  delete PostGISPG18.source;
  PostGISPG18.deploy = { limitOverride: { containers: { cpu: 8, memoryBytes: 4000000000 } } };
  PostGISPG18.networking = { privateNetworkEndpoint: 'postgis---pg18', tcpProxies: { '5432': {} } };
  const postgisPg18Volume = volume('postgis-pg18-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'us-west2',
    sizeMB: 50000,
  });
  const boardseshOtaClickhouseData = volume('boardsesh-ota-clickhouse-data', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'us-west2',
    sizeMB: 50000,
  });
  const redisVolume = volume('redis-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'us-west2',
    sizeMB: 5000,
  });
  const postgresVolume = volume('postgres-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'us-west2',
    sizeMB: 50000,
  });
  const boardseshS3Bucket = bucket('boardsesh-s3-bucket', { region: 'sjc' });
  const boardseshOtaV3 = service('boardsesh-ota-v3', {
    source: image('ghcr.io/mercuretechnologies/expo-open-ota:v3.2.5'),
    healthcheck: '/hc',
    healthcheckTimeout: 100,
    replicas: { 'us-west2': 1 },
    deploy: {
      drainingSeconds: 15,
      limitOverride: { containers: { cpu: 2, memoryBytes: 1000000000 } },
      restartPolicyType: 'ALWAYS',
    },
    domains: ['updates.boardsesh.com'],
    env: {
      ADMIN_EMAIL: preserve(),
      ADMIN_PASSWORD: preserve(),
      AWS_ACCESS_KEY_ID: preserve(),
      AWS_BASE_ENDPOINT: preserve(),
      AWS_REGION: preserve(),
      AWS_SECRET_ACCESS_KEY: preserve(),
      BASE_URL: preserve(),
      CACHE_KEY_PREFIX: preserve(),
      CACHE_MODE: preserve(),
      CLICKHOUSE_URL: preserve(),
      DB_KEYS_MASTER_KEY_B64: preserve(),
      DB_URL: preserve(),
      JWT_SECRET: preserve(),
      PROMETHEUS_ENABLED: preserve(),
      REDIS_HOST: preserve(),
      REDIS_PASSWORD: preserve(),
      REDIS_PORT: preserve(),
      S3_BUCKET_NAME: preserve(),
      STORAGE_MODE: preserve(),
      USE_DASHBOARD: preserve(),
    },
  });
  const boardseshBackend = service('boardsesh-backend', {
    source: image('ghcr.io/boardsesh/boardsesh-daemon:production'),
    build: {
      buildCommand: 'npm run build --workspace=boardsesh-backend',
      buildEnvironment: 'V3',
      builder: 'RAILPACK',
      watchPatterns: ['/packages/backend/**'],
    },
    healthcheck: '/health',
    preDeploy: [],
    replicas: { 'us-west2': 2 },
    deploy: { limitOverride: { containers: { cpu: 6, memoryBytes: 8000000000 } } },
    domains: ['ws.boardsesh.com'],
    env: {
      ADMIN_EMAIL: preserve(),
      APNS_BUNDLE_ID: preserve(),
      APNS_KEY_CONTENTS: preserve(),
      APNS_KEY_ID: preserve(),
      APNS_PRODUCTION: preserve(),
      APNS_TEAM_ID: preserve(),
      APPLE_BUNDLE_ID: preserve(),
      AURORA_CREDENTIALS_SECRET: preserve(),
      AWS_ACCESS_KEY_ID: preserve(),
      AWS_DEFAULT_REGION: preserve(),
      AWS_ENDPOINT_URL: preserve(),
      AWS_S3_BUCKET_NAME: preserve(),
      AWS_SECRET_ACCESS_KEY: preserve(),
      AXIOM_DATASET: preserve(),
      AXIOM_TOKEN: preserve(),
      BACKEND_PUBLIC_URL: preserve(),
      BACKEND_URL: preserve(),
      BATCH_FAMILIES_ENABLED: preserve(),
      BOARDSESH_URL: preserve(),
      BOARD_PRESENCE_ENABLED: preserve(),
      CREDENTIALS_ENCRYPTION_KEY: preserve(),
      CRON_SECRET: preserve(),
      DATABASE_URL: preserve(),
      DISCORD_FEEDBACK_URL: preserve(),
      EMAIL_FROM: preserve(),
      FEEDBACK_GITHUB_APP_ID: preserve(),
      FEEDBACK_GITHUB_APP_PRIVATE_KEY: preserve(),
      FEEDBACK_GITHUB_TOKEN: preserve(),
      GOOGLE_ANDROID_CLIENT_ID: preserve(),
      GOOGLE_IOS_CLIENT_ID: preserve(),
      GOOGLE_WEB_CLIENT_ID: preserve(),
      INFERRED_SESSIONS_ENABLED: preserve(),
      INTERNAL_SERVICE_SECRET: preserve(),
      KILTER_LIVE_SYNC_ENABLED: preserve(),
      KILTER_OAUTH_CLIENT_ID: preserve(),
      KILTER_OAUTH_REDIRECT_URI: preserve(),
      KILTER_SYNC_ALLOWED_USER_IDS: preserve(),
      MEDIA_AWS_ACCESS_KEY_ID: preserve(),
      MEDIA_AWS_ENDPOINT_URL: preserve(),
      MEDIA_AWS_REGION: preserve(),
      MEDIA_AWS_SECRET_ACCESS_KEY: preserve(),
      MEDIA_PUBLIC_BASE_URL: preserve(),
      MEDIA_S3_BUCKET_NAME: preserve(),
      NEXTAUTH_SECRET: preserve(),
      NODE_ENV: preserve(),
      POSTHOG_ENVIRONMENT: preserve(),
      POSTHOG_HOST: preserve(),
      POSTHOG_PROJECT_KEY: preserve(),
      PRIVATE_AWS_ACCESS_KEY_ID: preserve(),
      PRIVATE_AWS_ENDPOINT_URL: preserve(),
      PRIVATE_AWS_REGION: preserve(),
      PRIVATE_AWS_SECRET_ACCESS_KEY: preserve(),
      PRIVATE_S3_BUCKET_NAME: preserve(),
      REDIS_URL: preserve(),
      REVALIDATE_SECRET: preserve(),
      SMTP_HOST: preserve(),
      SMTP_PASSWORD: preserve(),
      SMTP_PORT: preserve(),
      SMTP_USER: preserve(),
      WEB_PUBLIC_URL: preserve(),
    },
  });
  // Retain existing deploy fields serialized in the imported live graph.
  boardseshBackend.deploy = {
    ...boardseshBackend.deploy,
    ipv6EgressEnabled: false,
    multiRegionConfig: {
      ...boardseshBackend.deploy?.multiRegionConfig,
      'us-west2': {
        numReplicas: 2,
        stackerAssignment: null,
      },
    },
    runtime: 'V2',
    useLegacyStacker: false,
  };
  const boardseshScheduler = service('boardsesh-scheduler', {
    source: image('ghcr.io/boardsesh/boardsesh-sync:production'),
    start: 'node --import tsx packages/scheduler/src/cli/index.ts start',
    healthcheck: '/health',
    healthcheckTimeout: 100,
    replicas: { 'us-west2': 1 },
    deploy: { limitOverride: { containers: { cpu: 2, memoryBytes: 2000000000 } }, restartPolicyMaxRetries: 5 },
    env: {
      BOARDSESH_WEB_URL: preserve(),
      CRON_SECRET: preserve(),
      NODE_ENV: preserve(),
      PORT: preserve(),
      SENTRY_DSN: preserve(),
      SENTRY_ENVIRONMENT: preserve(),
    },
  });
  const boardseshWeb = service('boardsesh-web', {
    source: image('ghcr.io/boardsesh/boardsesh-web:production'),
    healthcheck: '/api/health',
    healthcheckTimeout: 100,
    replicas: { 'us-west2': 1 },
    deploy: { limitOverride: { containers: { cpu: 3, memoryBytes: 4000000000 } }, restartPolicyMaxRetries: 5 },
    domains: [{ domain: 'www.boardsesh.com', port: 3000 }],
    env: {
      APPLE_ID: preserve(),
      APPLE_SECRET: preserve(),
      AWS_ACCESS_KEY_ID: preserve(),
      AWS_DEFAULT_REGION: preserve(),
      AWS_ENDPOINT_URL: preserve(),
      AWS_S3_BUCKET_NAME: preserve(),
      AWS_SECRET_ACCESS_KEY: preserve(),
      BACKEND_INTERNAL_URL: preserve(),
      BASE_URL: preserve(),
      BOARDSESH_WEB: preserve(),
      CRON_SECRET: preserve(),
      DATABASE_URL: preserve(),
      DB_POOL_MAX: preserve(),
      EMAIL_VERIFICATION_ENABLED: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      HOSTNAME: preserve(),
      INTERNAL_SERVICE_SECRET: preserve(),
      NEXTAUTH_SECRET: preserve(),
      NEXTAUTH_URL: preserve(),
      NODE_ENV: preserve(),
      PORT: preserve(),
      POSTHOG_HOST: preserve(),
      POSTHOG_PROJECT_KEY: preserve(),
      REVALIDATE_SECRET: preserve(),
      SENTRY_ENVIRONMENT: preserve(),
      SMTP_PASSWORD: preserve(),
      SMTP_USER: preserve(),
      STRIPE_DONATE_URL: preserve(),
    },
  });
  const boardseshOtaClickhouse = service('boardsesh-ota-clickhouse', {
    source: image(
      'ghcr.io/boardsesh/boardsesh-clickhouse@sha256:80d3d4c0dfacbd845476eea56ca239a3d658e868e01389ed264e1a9ecf56f6fd',
    ),
    replicas: { 'us-west2': 1 },
    deploy: { limitOverride: { containers: { cpu: 2, memoryBytes: 2000000000 } } },
    volumeMounts: { '/var/lib/clickhouse': boardseshOtaClickhouseData },
    env: {
      CLICKHOUSE_DB: preserve(),
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: preserve(),
      CLICKHOUSE_PASSWORD: preserve(),
      CLICKHOUSE_USER: preserve(),
    },
  });
  const boardseshPostgresForwarder = service('boardsesh-postgres-tailscale-forwarder', {
    healthcheck: '/readyz',
    healthcheckTimeout: 60,
    deploy: {
      drainingSeconds: 65,
      restartPolicyMaxRetries: 10,
      restartPolicyType: 'ON_FAILURE',
    },
  });

  return project('boardsesh', {
    resources: [
      boardseshOtaV3,
      Postgres,
      boardseshBackend,
      Redis,
      boardseshScheduler,
      boardseshWeb,
      PostGISPG18,
      boardseshOtaClickhouse,
      postgisPg18Volume,
      boardseshOtaClickhouseData,
      redisVolume,
      postgresVolume,
      boardseshS3Bucket,
      boardseshPostgresForwarder,
    ],
  });
});
