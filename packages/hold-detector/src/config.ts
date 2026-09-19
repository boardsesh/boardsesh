import { SPRAY_DETECTION_MODEL_VERSION, SPRAY_DETECTION_WEIGHTS_SHA256 } from '@boardsesh/shared-schema';

export function detectorConfig(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const required = (name: string) => {
    const setting = environment[name];
    if (!setting) throw new Error(`Missing ${name}`);
    return setting;
  };
  const databaseUrl = required('DATABASE_URL');
  const database = new URL(databaseUrl);
  const local = ['localhost', '127.0.0.1', '::1'].includes(database.hostname);
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    (!local && database.searchParams.get('sslmode') !== 'verify-full')
  ) {
    throw new Error('DATABASE_URL must verify TLS for remote PostgreSQL');
  }
  const endpoint = required('PRIVATE_AWS_ENDPOINT_URL_S3');
  if (new URL(endpoint).protocol !== 'https:') throw new Error('Private object storage requires HTTPS');
  const healthPort = Number(environment.HEALTH_PORT ?? 9090);
  if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65535) throw new Error('Invalid health port');
  return {
    databaseUrl,
    endpoint,
    bucket: required('PRIVATE_S3_BUCKET_NAME'),
    accessKeyId: required('PRIVATE_AWS_ACCESS_KEY_ID'),
    secretAccessKey: required('PRIVATE_AWS_SECRET_ACCESS_KEY'),
    region: environment.PRIVATE_AWS_REGION ?? 'auto',
    model: {
      baseUrl: 'https://media.boardsesh.com/models/hold-detector',
      version: SPRAY_DETECTION_MODEL_VERSION,
      weightsSha256: SPRAY_DETECTION_WEIGHTS_SHA256,
      cacheDir: environment.MODEL_CACHE_DIR ?? '/var/cache/hold-detector',
      threads: 2,
    },
    healthPort,
  };
}
