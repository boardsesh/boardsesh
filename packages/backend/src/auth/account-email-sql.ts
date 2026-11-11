import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** JS `String.prototype.trim`'s whitespace set as a regex class, so SQL groups like `trim().toLowerCase()`. */
const JS_TRIM_CLASS = String.raw`[\t\n\v\f\r    -     　﻿]`;
const JS_TRIM_PATTERN = sql.raw(`'^${JS_TRIM_CLASS}+|${JS_TRIM_CLASS}+$'`);

export function sqlNormalizedAccountEmail(email: SQLWrapper): SQL {
  return sql`pg_catalog.lower(pg_catalog.regexp_replace(${email}, ${JS_TRIM_PATTERN}, '', 'g'))`;
}
