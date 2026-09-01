type QueryClient = {
  unsafe: (query: string) => Promise<unknown>;
};

export function databaseEndpointIdentity(connectionString: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(connectionString);
  } catch {
    // ERR_INVALID_URL may retain its input, which can include credentials. Do
    // not propagate it into CI logs.
    throw new Error('DATABASE_DIRECT_URL is not a valid PostgreSQL URL');
  }
  if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
    throw new Error('DATABASE_DIRECT_URL must use the postgres or postgresql protocol');
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('DATABASE_DIRECT_URL contains an invalid database name');
  }
  if (!parsedUrl.hostname || !databaseName) {
    throw new Error('DATABASE_DIRECT_URL must include a hostname and database name');
  }

  return `${parsedUrl.hostname.toLowerCase()}:${parsedUrl.port || '5432'}/${databaseName}`;
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

  if (databaseEndpointIdentity(connectionString) !== expectedEndpoint) {
    throw new Error('DATABASE_DIRECT_URL does not match the trusted PostgreSQL endpoint');
  }
}

export async function verifyDirectConnectivity(client: QueryClient): Promise<void> {
  await client.unsafe('SELECT 1');
}
