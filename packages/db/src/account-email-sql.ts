import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

// Exactly the ECMAScript String.prototype.trim code points. The SQL Unicode
// escapes keep generated DDL and the owner command printable and reviewable.
const JS_TRIM_CHARACTERS = sql.raw(
  String.raw`U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'`,
);

/** SQL counterpart of normalizeAccountEmail: trim the JS set, then lowercase. */
export function sqlNormalizedAccountEmail(email: SQLWrapper): SQL {
  return sql`pg_catalog.lower(pg_catalog.btrim(${email}, ${JS_TRIM_CHARACTERS}))`;
}
