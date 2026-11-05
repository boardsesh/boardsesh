/** Test infrastructure boundary, never a production destination validator. */
export function ownedAppRouterAdminDatabase(input: string | undefined): string {
  if (!input) throw new Error('Explicit browser proof requires BOARDSESH_AUTH_PROOF_DATABASE_URL');
  const database = new URL(input);
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['127.0.0.1', 'localhost'].includes(database.hostname) ||
    !['15475', '15478'].includes(database.port) ||
    database.pathname !== '/boardsesh_backend_test' ||
    database.username !== 'postgres' ||
    !database.password ||
    database.search ||
    database.hash
  )
    throw new Error('Explicit browser proof requires an owned local admin database');
  return database.href;
}

export function ownedAppRouterDatabase(input: string): URL {
  const database = new URL(input);
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['127.0.0.1', 'localhost'].includes(database.hostname) ||
    !['5433', '15475', '15478'].includes(database.port) ||
    !/^\/boardsesh_backend_test_w(?:0|[1-9]\d{0,15})(?:_[a-f0-9]{12})?$/.test(database.pathname) ||
    !/^ba03_router_(?:stock|browser|readonly)_[a-f0-9]{32}$/.test(database.username) ||
    !/^[a-f0-9]{64}$/.test(database.password) ||
    database.search ||
    database.hash
  )
    throw new Error('Unowned proof database refused');
  return database;
}
