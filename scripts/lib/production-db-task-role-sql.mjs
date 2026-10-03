// Every contract value that reaches `sqlClient.unsafe()` in the production task-role
// provisioner is quoted or allowlisted here. PostgreSQL has no bind parameters for
// privilege keywords, identifiers or CONNECTION LIMIT, so those interpolate literally --
// which makes an unvalidated contract entry such as
// `databasePrivileges: ['CONNECT; DROP ROLE boardsesh_owner --']` an executable statement.
// These helpers fail closed: only the exact keywords the contract legitimately uses pass,
// and adding a new privilege means widening the allowlist in review.

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

// Upper bound for a CI task role. Every managed role today asks for 2 or 10 connections;
// anything larger is a contract mistake rather than a legitimate task-role need.
export const MAX_TASK_CONNECTION_LIMIT = 100;

export const ALLOWED_DATABASE_PRIVILEGES = Object.freeze(['CONNECT', 'TEMPORARY']);
export const ALLOWED_SCHEMA_PRIVILEGES = Object.freeze(['USAGE']);
export const ALLOWED_RELATION_PRIVILEGES = Object.freeze(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);

const ALLOWED_PRIVILEGES_BY_SCOPE = new Map([
  ['database', new Set(ALLOWED_DATABASE_PRIVILEGES)],
  ['schema', new Set(ALLOWED_SCHEMA_PRIVILEGES)],
  ['relation', new Set(ALLOWED_RELATION_PRIVILEGES)],
]);

export function fail(message) {
  throw new Error(message);
}

export function quoteIdentifier(identifier) {
  if (typeof identifier !== 'string' || !IDENTIFIER_PATTERN.test(identifier)) {
    fail(`unsafe PostgreSQL identifier: ${String(identifier)}`);
  }
  return `"${identifier}"`;
}

export function quoteLiteral(literal) {
  return `'${String(literal).replaceAll("'", "''")}'`;
}

export function valuesList(values) {
  return values.map(quoteLiteral).join(', ');
}

export function qualifiedRelationSql(schemaName, relationName) {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(relationName)}`;
}

// Validates one privilege array without building SQL; an empty array is a role that asks
// for nothing at that scope (the migrator holds no schema privileges).
export function assertPrivileges(scope, privileges, context) {
  const allowedPrivileges = ALLOWED_PRIVILEGES_BY_SCOPE.get(scope);
  if (!allowedPrivileges) fail(`unknown privilege scope ${String(scope)}`);
  if (!Array.isArray(privileges)) fail(`${context} must declare ${scope} privileges as an array`);
  const seenPrivileges = new Set();
  for (const privilege of privileges) {
    if (typeof privilege !== 'string' || !allowedPrivileges.has(privilege)) {
      fail(`unsafe ${scope} privilege for ${context}: ${JSON.stringify(privilege)}`);
    }
    if (seenPrivileges.has(privilege)) fail(`duplicate ${scope} privilege for ${context}: ${privilege}`);
    seenPrivileges.add(privilege);
  }
}

// The only way a privilege keyword is allowed into a GRANT statement.
export function privilegeListSql(scope, privileges, context) {
  assertPrivileges(scope, privileges, context);
  if (privileges.length === 0) fail(`${context} must grant at least one ${scope} privilege`);
  return privileges.join(', ');
}

// The only way a connection limit is allowed into an ALTER ROLE statement. PostgreSQL
// accepts -1 for "unlimited"; no managed task role wants that, so it is rejected too.
export function connectionLimitSql(connectionLimit, context) {
  if (
    typeof connectionLimit !== 'number' ||
    !Number.isSafeInteger(connectionLimit) ||
    connectionLimit < 0 ||
    connectionLimit > MAX_TASK_CONNECTION_LIMIT
  ) {
    fail(`unsafe connection limit for ${context}: ${JSON.stringify(connectionLimit) ?? String(connectionLimit)}`);
  }
  return String(connectionLimit);
}

// Fail-closed gate over the whole static contract, run before any command touches the
// database so `plan` and `audit` reject a poisoned contract just as `apply` does.
export function assertContractSqlSafety(taskRoles, relationGrants) {
  for (const roleContract of taskRoles) {
    quoteIdentifier(roleContract.name);
    connectionLimitSql(roleContract.connectionLimit, roleContract.name);
    assertPrivileges('database', roleContract.databasePrivileges, roleContract.name);
    assertPrivileges('schema', roleContract.schemaPrivileges, roleContract.name);
  }
  for (const grantContract of relationGrants) {
    quoteIdentifier(grantContract.role);
    quoteIdentifier(grantContract.relation);
    const grantContext = `${grantContract.role} on ${grantContract.relation}`;
    assertPrivileges('relation', grantContract.privileges, grantContext);
    if (grantContract.privileges.length === 0) fail(`empty privileges for ${grantContract.role}`);
  }
}
