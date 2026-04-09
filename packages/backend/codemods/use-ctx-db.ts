import type { FileInfo, API, Options } from 'jscodeshift';

const DB_CLIENT_IMPORTS = ['../../../db/client', '@boardsesh/db/client', '../../db/client'];
const REQUEST_DB_TYPE = "import type { RequestDbInstance } from '@boardsesh/db/client';";
const MODULE_DB = "import { createRequestDb } from '@boardsesh/db/client';\n\nconst db = createRequestDb();\n";

module.exports = function transformer(
  file: FileInfo,
  api: API,
  options: Options,
): string | null {
  const j = api.jscodeshift;
  const source = file.source;

  // Skip files that don't use db
  if (
    !source.includes('await db') &&
    !source.includes('db.select') &&
    !source.includes('db.insert') &&
    !source.includes('db.update') &&
    !source.includes('db.delete') &&
    !source.includes('db.transaction') &&
    !source.includes('db.execute')
  ) {
    return null;
  }

  // Skip files that already have ctx.db pattern
  if (source.includes('ctx.db as RequestDbInstance')) {
    return null;
  }

  let hasModifications = false;
  let result = source;

  // Step 1: Remove { db } imports from db/client modules
  for (const imp of DB_CLIENT_IMPORTS) {
    const escapedImp = imp.replace('/', '\\/');
    // Match import { db } from 'path';
    const regex1 = new RegExp(`import\\s{\\s*db\\s*}\\s*from\\s*['"]${escapedImp}['"];?\\n?`, 'g');
    const newResult1 = result.replace(regex1, '');
    if (newResult1 !== result) {
      result = newResult1;
      hasModifications = true;
    }

    // Match import { db } from "path";
    const regex2 = new RegExp(`import\\s{\\s*db\\s*}\\s*from\\s*"${escapedImp}";?\\n?`, 'g');
    const newResult2 = result.replace(regex2, '');
    if (newResult2 !== result) {
      result = newResult2;
      hasModifications = true;
    }
  }

  // Step 2: Check if file has ctx: ConnectionContext in any resolver
  const hasCtx = /ctx:\s*ConnectionContext/.test(result);

  if (hasCtx) {
    // Step 3a: Add RequestDbInstance type import after first import
    if (!result.includes('RequestDbInstance')) {
      const firstImportMatch = result.match(/^import\s+.+?\n/m);
      if (firstImportMatch) {
        const insertPos = result.indexOf(firstImportMatch[0]) + firstImportMatch[0].length;
        result = result.slice(0, insertPos) + '\n' + REQUEST_DB_TYPE + result.slice(insertPos);
        hasModifications = true;
      }
    }

    // Step 4a: Add const db = ctx.db as RequestDbInstance; to resolver functions with ctx
    // Pattern: name: async (..., ctx: ConnectionContext, ...) => {
    const resolverPattern = /(\w+):\s*async\s*\([^)]*ctx:\s*ConnectionContext[^)]*\)[^}]*=>\s*{/g;

    result = result.replace(resolverPattern, (match, resolverName) => {
      // Skip if already has db assignment
      if (match.includes('const db = ctx.db')) {
        return match;
      }

      // Insert the db assignment right after the opening brace
      const insertion = '\n    const db = ctx.db as RequestDbInstance;';
      hasModifications = true;
      return match + insertion;
    });
  } else {
    // Step 3b: For files without ctx, add module-level db
    if (!result.includes('createRequestDb')) {
      const firstImportMatch = result.match(/^import\s+.+?\n/m);
      if (firstImportMatch) {
        const insertPos = result.indexOf(firstImportMatch[0]) + firstImportMatch[0].length;
        result = result.slice(0, insertPos) + '\n' + MODULE_DB + result.slice(insertPos);
        hasModifications = true;
      }
    }
  }

  return hasModifications ? result : null;
};

module.exports.parser = 'tsx';
