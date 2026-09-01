import { pathToFileURL } from 'node:url';
import { PRODUCTION_TASK_ROLE_BY_NAME } from './lib/production-db-task-role-contract.mjs';

const FORWARDER_HOST_PATTERN = /^boardsesh-db-forwarder\.([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/;

export function validateProductionDatabaseRoute(rawDatabaseUrl, expectedHost, expectedRole) {
  if (!expectedHost || !FORWARDER_HOST_PATTERN.test(expectedHost)) {
    throw new Error('POSTGRES_FORWARDER_HOST must be the full boardsesh-db-forwarder MagicDNS name');
  }
  const roleContract = PRODUCTION_TASK_ROLE_BY_NAME.get(expectedRole);
  if (!expectedRole || !roleContract) {
    throw new Error('EXPECTED_DATABASE_ROLE must be an approved task-specific Boardsesh role');
  }
  const expectedApplicationName = roleContract.applicationName;
  if (!rawDatabaseUrl) throw new Error('direct database URL is unset');

  let databaseUrl;
  try {
    databaseUrl = new URL(rawDatabaseUrl);
  } catch {
    throw new Error('direct database URL is not a valid URL');
  }
  if (databaseUrl.protocol !== 'postgres:' && databaseUrl.protocol !== 'postgresql:') {
    throw new Error('direct database URL must use postgres:// or postgresql://');
  }
  if (databaseUrl.hostname !== expectedHost || databaseUrl.port !== '5432') {
    throw new Error('direct database URL must target POSTGRES_FORWARDER_HOST on port 5432');
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  } catch {
    throw new Error('direct database URL contains an invalid encoded database name');
  }
  if (databaseName !== 'railway') {
    throw new Error('direct database URL must target the railway database');
  }
  if (databaseUrl.hash) throw new Error('direct database URL must not include a fragment');

  let username;
  try {
    username = decodeURIComponent(databaseUrl.username);
  } catch {
    throw new Error('direct database URL contains an invalid encoded username');
  }
  if (!username || !databaseUrl.password) {
    throw new Error('direct database URL must include SCRAM credentials');
  }
  if (username !== expectedRole) {
    throw new Error('direct database URL must use the expected task-specific role');
  }

  const forbiddenOverrides = new Set([
    'dbname',
    'host',
    'hostaddr',
    'password',
    'port',
    'service',
    'servicefile',
    'user',
  ]);
  let applicationNameCount = 0;
  let sslModeCount = 0;
  for (const [queryName, queryValue] of databaseUrl.searchParams) {
    const normalizedQueryName = queryName.toLowerCase();
    if (forbiddenOverrides.has(normalizedQueryName)) {
      throw new Error(`direct database URL must not override ${normalizedQueryName} in query parameters`);
    }
    if (normalizedQueryName === 'options') {
      if (/\b(role|session_authorization)\s*=/i.test(queryValue)) {
        throw new Error('direct database URL must not set a startup role');
      }
      throw new Error('direct database URL must not set PostgreSQL startup options');
    }
    if (normalizedQueryName === 'application_name') {
      applicationNameCount += 1;
      if (queryName !== normalizedQueryName || queryValue !== expectedApplicationName) {
        throw new Error('direct database URL must use the expected task-specific application_name');
      }
      continue;
    }
    if (normalizedQueryName === 'sslmode') {
      sslModeCount += 1;
      if (queryName !== normalizedQueryName || queryValue !== 'require') {
        throw new Error('direct database URL must require PostgreSQL TLS');
      }
      continue;
    }
    throw new Error(`direct database URL must not set query parameter ${normalizedQueryName}`);
  }
  if (applicationNameCount !== 1) {
    throw new Error('direct database URL must set exactly one task-specific application_name');
  }
  if (sslModeCount !== 1) {
    throw new Error('direct database URL must set sslmode=require exactly once');
  }

  return { hostname: databaseUrl.hostname, port: 5432 };
}

function main() {
  try {
    const route = validateProductionDatabaseRoute(
      process.env.DATABASE_URL_INPUT,
      process.env.FORWARDER_HOST_INPUT,
      process.env.EXPECTED_DATABASE_ROLE_INPUT,
    );
    console.log(`Validated private database route ${route.hostname}:${route.port}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown direct URL validation error';
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
