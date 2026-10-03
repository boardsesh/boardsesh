/** Replace only the database name while retaining connection URL options. */
export function withPostgresDatabaseName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new TypeError(`Expected a PostgreSQL URL, received protocol ${url.protocol || '(missing)'}`);
  }
  url.pathname = `/${databaseName}`;
  return url.toString();
}
