type QueryClient = {
  unsafe: (query: string) => Promise<unknown>;
};

export const DIRECT_DATABASE_PROBE_TIMEOUT_MS = 15_000;

export function databaseEndpointIdentity(connectionString: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(connectionString);
  } catch {
    // ERR_INVALID_URL may retain its input, which can include credentials. Do
    // not propagate it into CI logs.
    throw new Error('MIGRATOR_DATABASE_URL is not a valid PostgreSQL URL');
  }
  if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
    throw new Error('MIGRATOR_DATABASE_URL must use the postgres or postgresql protocol');
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('MIGRATOR_DATABASE_URL contains an invalid database name');
  }
  if (!parsedUrl.hostname || !databaseName) {
    throw new Error('MIGRATOR_DATABASE_URL must include a hostname and database name');
  }

  const port = Number(parsedUrl.port || '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MIGRATOR_DATABASE_URL port must be between 1 and 65535');
  }
  return `${parsedUrl.hostname.toLowerCase()}:${port}/${databaseName}`;
}

/**
 * Compare only the non-credential endpoint identity. The protected environment
 * pins the known Railway PostgreSQL TCP endpoint; PgBouncer has a different
 * hostname or port. Password rotation therefore needs no workflow change, while
 * moving the direct endpoint remains an explicit fail-closed operation.
 */
export function assertExpectedDirectEndpoint(connectionString: string, expectedEndpoint: string): void {
  if (!expectedEndpoint) {
    throw new Error('DATABASE_DIRECT_ENDPOINT is required to identify the trusted PostgreSQL endpoint');
  }

  let normalizedExpectedEndpoint: string;
  try {
    const expectedUrl = new URL(`postgresql://${expectedEndpoint}`);
    if (expectedUrl.username || expectedUrl.password || expectedUrl.search || expectedUrl.hash) throw new Error();
    normalizedExpectedEndpoint = databaseEndpointIdentity(expectedUrl.href);
  } catch {
    // One message for every parse failure on purpose: the inner error can echo
    // the variable, and a value with embedded credentials must never reach the log.
    throw new Error('DATABASE_DIRECT_ENDPOINT must be a valid host:port/database identity');
  }

  if (databaseEndpointIdentity(connectionString) !== normalizedExpectedEndpoint) {
    throw new Error('MIGRATOR_DATABASE_URL does not match the trusted PostgreSQL endpoint');
  }
}

export async function verifyDirectConnectivity(
  client: QueryClient,
  timeoutMs = DIRECT_DATABASE_PROBE_TIMEOUT_MS,
): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error('MIGRATOR_DATABASE_URL timed out during SELECT 1 verification'));
    }, timeoutMs);
  });

  try {
    await Promise.race([client.unsafe('SELECT 1'), timeout]);
  } catch {
    throw new Error('MIGRATOR_DATABASE_URL failed TLS connectivity or SELECT 1 verification');
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
