import { pathToFileURL } from 'node:url';

const FORWARDER_HOST_PATTERN = /^boardsesh-db-forwarder\.([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/;

const ALLOWED_DATABASE_ROLES = new Set([
  'boardsesh_migrator',
  'boardsesh_snapshot_exporter',
  'boardsesh_climb_grades_refresh',
  'boardsesh_content_model_refresh',
  'boardsesh_hold_features_refresh',
  'boardsesh_recommendations_refresh',
]);

// PostgreSQL splits options on ASCII whitespace, with backslash escaping the
// next character (not shell quoting). Restrict this route to -c/-- setting
// assignments so compact or escaped role changes cannot bypass the login gate.
// https://www.postgresql.org/docs/17/libpq-connect.html#LIBPQ-CONNECT-OPTIONS
function validateStartupOptions(rawOptions) {
  const unsupported = () => new Error('direct database URL contains unsupported startup options');
  if (rawOptions.includes('\0')) throw unsupported();
  const optionArguments = [];
  let argument = '';
  for (let index = 0; index < rawOptions.length; index += 1) {
    const character = rawOptions[index];
    if (character === '\\') {
      index += 1;
      if (index >= rawOptions.length) throw unsupported();
      argument += rawOptions[index];
    } else if (/[ \t\n\r\f\v]/.test(character)) {
      if (argument) optionArguments.push(argument);
      argument = '';
    } else {
      argument += character;
    }
  }
  if (argument) optionArguments.push(argument);

  for (let index = 0; index < optionArguments.length; index += 1) {
    const option = optionArguments[index];
    let assignment;
    if (option === '-c') {
      index += 1;
      assignment = optionArguments[index];
    } else if (option.startsWith('-c')) {
      assignment = option.slice(2);
    } else if (option.startsWith('--')) {
      assignment = option.slice(2);
    } else {
      throw unsupported();
    }
    const equalsAt = assignment?.indexOf('=') ?? -1;
    if (equalsAt <= 0) throw unsupported();
    // PostgreSQL's ParseLongOption folds hyphens to underscores; GUC names
    // are case-insensitive. Values may contain '=' or escaped spaces.
    const settingName = assignment.slice(0, equalsAt).replaceAll('-', '_').toLowerCase();
    if (!/^[a-z_][a-z0-9_.]*$/.test(settingName)) throw unsupported();
    if (settingName === 'role' || settingName === 'session_authorization') {
      throw new Error('direct database URL must not set a startup role');
    }
  }
}

export function validateProductionDatabaseRoute(rawDatabaseUrl, expectedHost, expectedRole) {
  if (!expectedHost || !FORWARDER_HOST_PATTERN.test(expectedHost)) {
    throw new Error('POSTGRES_FORWARDER_HOST must be the full boardsesh-db-forwarder MagicDNS name');
  }
  if (!expectedRole || !ALLOWED_DATABASE_ROLES.has(expectedRole)) {
    throw new Error('EXPECTED_DATABASE_ROLE must be an approved task-specific Boardsesh role');
  }
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
  const startupOptions = [];
  for (const [queryName, queryValue] of databaseUrl.searchParams) {
    const normalizedQueryName = queryName.toLowerCase();
    if (forbiddenOverrides.has(normalizedQueryName)) {
      throw new Error(`direct database URL must not override ${normalizedQueryName} in query parameters`);
    }
    if (normalizedQueryName === 'options') startupOptions.push(queryValue);
  }
  for (const options of startupOptions) validateStartupOptions(options);

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
