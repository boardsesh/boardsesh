#!/usr/bin/env node
/**
 * Two-way static check over the i18n catalogs and the code that reads them,
 * across `packages/web/app/`, `packages/web/scripts/`, and `packages/mobile/{src,app}/`:
 *
 *   - ORPHANS — a key in `packages/shared/i18n/locales/en-US/<ns>.json` with no
 *     live reference. en-US is the source of truth — `es`, `fr`, and `de` fall
 *     back through i18next, so an orphan in en-US is an orphan in every locale.
 *   - MISSING — a `t()` / `<Trans>` reference to a key that exists in no catalog.
 *     i18next has no `parseMissingKeyHandler` here, so it renders the raw key: a
 *     button labelled `playView.resetZoom` instead of "Reset zoom" (#4416).
 *   - MOBILE NAMESPACES — a file under `packages/mobile/` reading a namespace
 *     that `MOBILE_NAMESPACES` leaves out of the mobile bundle, so every key in
 *     it renders raw on device while resolving fine on web.
 *
 * The missing direction is deliberately lenient — it only reports a key when the
 * reference is statically resolvable and no candidate namespace defines it (see
 * `computeMissingKeys`). Template-literal globs are skipped entirely.
 *
 * What gets resolved as a reference:
 *   1. `t('foo.bar')` / `t('marketing:foo.bar')` with a static string literal,
 *      where `t` is bound from `useTranslation(...)`,
 *      `await getServerTranslation(...)`, or a function parameter typed as
 *      `TFunction<'ns'>` / `TFunction<['ns1', 'ns2']>`.
 *   2. `t(\`prefix.${expr}.suffix\`)` template literals — converted to a glob
 *      pattern `prefix.*.suffix` that matches any catalog key with the same
 *      shape. Wildcards match exactly one dot-separated segment.
 *   3. `<Trans i18nKey="foo.bar" t={t} />` — same rules as `t()`.
 *   4. Plural variants — `<base>_one`, `<base>_other`, etc. count as
 *      referenced when the base key is referenced (i18next picks the variant
 *      at runtime via `t('base', { count })`).
 *
 * Conservative fallback: when a `t` identifier can't be resolved to any
 * binding (helper that received `t: TFunction` with no namespace argument),
 * the key is recorded as used in every namespace. That over-marks slightly
 * but never produces false orphans.
 *
 * Per-key opt-out: `// i18n-keep namespace.dotted.key` (or
 * `// i18n-keep ns:key.path`) anywhere in the scanned file set marks a key
 * as intentionally retained even with no reference. Use this for keys
 * referenced from outside the scanned tree (e.g. backend, middleware) or
 * placeholder copy not yet wired up.
 *
 * Hard-fails on `t(variable)` / `t('a' + b)` — inline the literal, switch to
 * a template literal we can statically analyse, or add `// i18n-keep` for
 * every key the dynamic call could resolve to.
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// TypeScript 7 ships no compiler API — its `typescript` entry point exports only
// the version string, and the `unstable/ast` subpath has the node guards but no
// source-text parser or `forEachChild`. The API returns in 7.1; until then this
// AST walk runs on a pinned 6.x copy. See `typescript-compiler-api` in package.json.
import ts from 'typescript-compiler-api';
import { MOBILE_NAMESPACES } from '@boardsesh/i18n';
import { DEFAULT_NAMESPACE } from '../app/lib/i18n/config';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const packagesRoot = join(webRoot, '..');
const appRoot = join(webRoot, 'app');
const scriptsRoot = join(webRoot, 'scripts');
const mobileSrcRoot = join(packagesRoot, 'mobile', 'src');
const mobileAppRoot = join(packagesRoot, 'mobile', 'app');
const catalogRoot = join(packagesRoot, 'shared', 'i18n', 'locales', 'en-US');
const repoRoot = join(webRoot, '..', '..');

const KEEP_MARKER = 'i18n-keep';
const WILD = '__I18N_ORPHAN_WILDCARD__';

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other', '_plural'];

const ANY_NAMESPACE = '__I18N_ORPHAN_ANY_NS__';

type GlobSegment = string | { wildcard: true };
type GlobPattern = { segments: GlobSegment[] };
type NsContext = { primary: string; bound: readonly string[] };
type Binding = { start: number; aliasName: string; scope: ts.Node; ctx: NsContext };
type UnanalyzableSite = { file: string; line: number; column: number; snippet: string };
/**
 * One statically-resolved `t()` / `<Trans>` reference. `namespaces` is the set
 * of namespaces the key could land in: the bound list for `useTranslation([a, b])`,
 * a single entry for `t('ns:key')`, or `[ANY_NAMESPACE]` when the `t` identifier
 * couldn't be traced back to a binding.
 */
type KeyReference = { key: string; namespaces: readonly string[]; file: string; line: number; column: number };

const ANY_CTX: NsContext = { primary: ANY_NAMESPACE, bound: [ANY_NAMESPACE] };

function isExcluded(absolutePath: string, root: string = repoRoot): boolean {
  const relativePath = relative(root, absolutePath);
  const normalized = `/${relativePath.split(sep).join('/')}`;
  if (normalized.includes('/node_modules/')) return true;
  if (normalized.includes('/.next/')) return true;
  if (normalized.includes('/dist/')) return true;
  if (normalized.includes('/generated/')) return true;
  if (normalized.includes('/__tests__/')) return true;
  if (normalized.endsWith('.d.ts')) return true;
  if (normalized.endsWith('.test.tsx') || normalized.endsWith('.test.ts')) return true;
  if (normalized.endsWith('.spec.tsx') || normalized.endsWith('.spec.ts')) return true;
  if (normalized.endsWith('.stories.tsx') || normalized.endsWith('.stories.ts')) return true;
  return false;
}

function discoverFiles(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const entries = readdirSync(root, { recursive: true });
    for (const entry of entries) {
      const relativeEntry = typeof entry === 'string' ? entry : entry.toString();
      if (!relativeEntry.endsWith('.ts') && !relativeEntry.endsWith('.tsx')) continue;
      const full = join(root, relativeEntry);
      if (isExcluded(full)) continue;
      files.push(full);
    }
  }
  return files;
}

function discoverNamespaces(): string[] {
  const namespaces: string[] = [];
  for (const entry of readdirSync(catalogRoot)) {
    if (!entry.endsWith('.json')) continue;
    namespaces.push(entry.slice(0, -'.json'.length));
  }
  return namespaces.sort();
}

function flattenCatalog(value: unknown, prefix: string, into: Set<string>): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) into.add(prefix);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${key}` : key;
    flattenCatalog(child, next, into);
  }
}

function loadCatalog(namespaces: readonly string[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const ns of namespaces) {
    const file = join(catalogRoot, `${ns}.json`);
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const keys = new Set<string>();
    flattenCatalog(parsed, '', keys);
    result.set(ns, keys);
  }
  return result;
}

function findEnclosingScope(node: ts.Node): ts.Node {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isSourceFile(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return node.getSourceFile();
}

function isAncestor(possibleAncestor: ts.Node, node: ts.Node): boolean {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (cur === possibleAncestor) return true;
    cur = cur.parent;
  }
  return false;
}

function getTAliasName(name: ts.BindingName): string | undefined {
  if (!ts.isObjectBindingPattern(name)) return undefined;
  for (const element of name.elements) {
    if (!ts.isBindingElement(element)) continue;
    const propertyName = element.propertyName;
    const target = element.name;
    if (propertyName === undefined) {
      if (ts.isIdentifier(target) && target.text === 't') return 't';
    } else if (ts.isIdentifier(propertyName) && propertyName.text === 't' && ts.isIdentifier(target)) {
      return target.text;
    }
  }
  return undefined;
}

function extractNsArg(callNode: ts.CallExpression): NsContext | undefined {
  const arg = callNode.arguments[0];
  if (!arg) {
    return { primary: DEFAULT_NAMESPACE, bound: [DEFAULT_NAMESPACE] };
  }
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { primary: arg.text, bound: [arg.text] };
  }
  if (ts.isArrayLiteralExpression(arg)) {
    const items: string[] = [];
    for (const element of arg.elements) {
      if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
        items.push(element.text);
      } else {
        return undefined;
      }
    }
    if (items.length === 0) return undefined;
    return { primary: items[0], bound: items };
  }
  return undefined;
}

function isI18nDestructureCall(initializer: ts.Expression): NsContext | undefined {
  const inner = ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
  if (!ts.isCallExpression(inner)) return undefined;
  const callee = inner.expression;
  let fnName: string | undefined;
  if (ts.isIdentifier(callee)) {
    fnName = callee.text;
  } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    fnName = callee.name.text;
  }
  if (fnName !== 'useTranslation' && fnName !== 'getServerTranslation') return undefined;
  return extractNsArg(inner);
}

function tFunctionParamContext(parameter: ts.ParameterDeclaration): NsContext | undefined {
  const typeNode = parameter.type;
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return undefined;
  const typeName = typeNode.typeName;
  const name = ts.isIdentifier(typeName)
    ? typeName.text
    : ts.isQualifiedName(typeName) && ts.isIdentifier(typeName.right)
      ? typeName.right.text
      : undefined;
  if (name !== 'TFunction') return undefined;
  const args = typeNode.typeArguments;
  if (!args || args.length === 0) {
    // Bare `TFunction` with no namespace info — treat as "any namespace".
    return ANY_CTX;
  }
  const first = args[0];
  if (ts.isLiteralTypeNode(first) && ts.isStringLiteral(first.literal)) {
    const ns = first.literal.text;
    return { primary: ns, bound: [ns] };
  }
  if (ts.isTupleTypeNode(first)) {
    const items: string[] = [];
    for (const element of first.elements) {
      if (ts.isLiteralTypeNode(element) && ts.isStringLiteral(element.literal)) {
        items.push(element.literal.text);
      }
    }
    if (items.length > 0) {
      return { primary: items[0], bound: items };
    }
  }
  return ANY_CTX;
}

function findEnclosingJsxOpening(node: ts.Node): ts.JsxOpeningElement | ts.JsxSelfClosingElement | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isJsxOpeningElement(cur) || ts.isJsxSelfClosingElement(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

function jsxAttributeName(attribute: ts.JsxAttribute): string {
  return ts.isIdentifier(attribute.name) ? attribute.name.text : attribute.name.getText();
}

function buildGlobFromTemplate(template: ts.TemplateExpression): GlobPattern {
  const parts: string[] = [template.head.text];
  for (const span of template.templateSpans) {
    parts.push(WILD);
    parts.push(span.literal.text);
  }
  const joined = parts.join('');
  const rawSegments = joined.split('.');
  const segments: GlobSegment[] = [];
  for (const seg of rawSegments) {
    if (seg === WILD || seg.includes(WILD)) {
      segments.push({ wildcard: true });
    } else {
      segments.push(seg);
    }
  }
  return { segments };
}

function globMatchesKey(pattern: GlobPattern, key: string): boolean {
  const keySegments = key.split('.');
  if (keySegments.length !== pattern.segments.length) return false;
  for (let i = 0; i < pattern.segments.length; i++) {
    const patternSegment = pattern.segments[i];
    if (typeof patternSegment === 'object') continue;
    if (patternSegment !== keySegments[i]) return false;
  }
  return true;
}

function pluralBaseKey(key: string): string | undefined {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length);
  }
  return undefined;
}

type FileAnalysis = {
  usedKeys: Map<string, Set<string>>;
  globs: Map<string, GlobPattern[]>;
  references: KeyReference[];
  referencedNamespaces: Set<string>;
  unanalyzable: UnanalyzableSite[];
  keepHints: Set<string>;
};

function analyzeFile(filePath: string, sourceOverride?: string): FileAnalysis {
  const source = sourceOverride ?? readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const usedKeys = new Map<string, Set<string>>();
  const globs = new Map<string, GlobPattern[]>();
  const references: KeyReference[] = [];
  const referencedNamespaces = new Set<string>();
  const unanalyzable: UnanalyzableSite[] = [];
  const keepHints = new Set<string>();
  const bindings: Binding[] = [];

  function recordKey(ns: string, key: string) {
    let set = usedKeys.get(ns);
    if (!set) {
      set = new Set();
      usedKeys.set(ns, set);
    }
    set.add(key);
    if (ns !== ANY_NAMESPACE) referencedNamespaces.add(ns);
  }

  function recordGlob(ns: string, pattern: GlobPattern) {
    let arr = globs.get(ns);
    if (!arr) {
      arr = [];
      globs.set(ns, arr);
    }
    arr.push(pattern);
    if (ns !== ANY_NAMESPACE) referencedNamespaces.add(ns);
  }

  function recordReference(namespaces: readonly string[], key: string, node: ts.Node) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    references.push({ key, namespaces, file: filePath, line: line + 1, column: character + 1 });
  }

  function findApplicableCtx(callNode: ts.Node, identifierName: string): NsContext | undefined {
    let best: NsContext | undefined;
    let bestStart = -1;
    const callStart = callNode.getStart(sourceFile);
    for (const binding of bindings) {
      if (binding.aliasName !== identifierName) continue;
      if (binding.start > callStart) continue;
      if (!isAncestor(binding.scope, callNode)) continue;
      if (binding.start > bestStart) {
        bestStart = binding.start;
        best = binding.ctx;
      }
    }
    return best;
  }

  function resolveStaticKey(rawKey: string, ctx: NsContext, node: ts.Node) {
    const colonIndex = rawKey.indexOf(':');
    if (colonIndex >= 0) {
      const ns = rawKey.slice(0, colonIndex);
      const key = rawKey.slice(colonIndex + 1);
      recordKey(ns, key);
      recordReference([ns], key, node);
      return;
    }
    for (const ns of ctx.bound) {
      recordKey(ns, rawKey);
    }
    recordReference(ctx.bound, rawKey, node);
  }

  // Returns true if the argument was statically resolvable (key recorded);
  // false if the linter cannot determine the key and should hard-fail.
  // Recurses through conditional/logical expressions so call shapes like
  // `t(flag ? 'a.key' : 'b.key')` and `t(maybe ?? 'fallback.key')` record
  // every literal branch.
  function resolveArgument(arg: ts.Expression, ctx: NsContext): boolean {
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      resolveStaticKey(arg.text, ctx, arg);
      return true;
    }
    if (ts.isTemplateExpression(arg)) {
      resolveTemplateKey(arg, ctx);
      return true;
    }
    if (ts.isParenthesizedExpression(arg)) {
      return resolveArgument(arg.expression, ctx);
    }
    if (ts.isConditionalExpression(arg)) {
      const left = resolveArgument(arg.whenTrue, ctx);
      const right = resolveArgument(arg.whenFalse, ctx);
      return left && right;
    }
    if (ts.isPropertyAccessExpression(arg) && arg.name.text.endsWith('I18nKey')) {
      // `t(preset.titleI18nKey)` — the `*I18nKey` property visitor records
      // the actual literal at the object definition site. Treat the read
      // as resolved so we don't hard-fail.
      return true;
    }
    if (
      ts.isBinaryExpression(arg) &&
      (arg.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        arg.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      // `a || 'fallback'` / `a ?? 'fallback'`: if either side is statically
      // resolvable, record it; only the static side contributes a catalog
      // reference. We don't hard-fail because the non-literal branch is
      // typically a value that itself resolved to a literal at a different
      // call site (e.g. `preset.titleI18nKey`), or one we want to treat as
      // "potentially used".
      const leftResolved = resolveArgument(arg.left, ctx);
      const rightResolved = resolveArgument(arg.right, ctx);
      return leftResolved || rightResolved;
    }
    return false;
  }

  function resolveTemplateKey(template: ts.TemplateExpression, ctx: NsContext) {
    const headText = template.head.text;
    const colonIndex = headText.indexOf(':');
    let pattern = buildGlobFromTemplate(template);
    let targetNamespaces: readonly string[] = ctx.bound;
    if (colonIndex >= 0) {
      const ns = headText.slice(0, colonIndex);
      const firstSegment = pattern.segments[0];
      if (typeof firstSegment === 'string') {
        const remainder = firstSegment.slice(colonIndex + 1);
        // `ns:${expr}.suffix` leaves an empty remainder — drop the empty
        // first segment instead of pushing `["", wildcard, "suffix"]`, which
        // would never match any catalog key.
        const remainderSegments: GlobSegment[] = remainder === '' ? [] : remainder.split('.');
        pattern = { segments: [...remainderSegments, ...pattern.segments.slice(1)] };
      }
      targetNamespaces = [ns];
    }
    for (const ns of targetNamespaces) {
      recordGlob(ns, pattern);
    }
  }

  function visitBindings(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const ctx = isI18nDestructureCall(node.initializer);
      if (ctx) {
        const aliasName = getTAliasName(node.name);
        if (aliasName) {
          bindings.push({
            start: node.getStart(sourceFile),
            aliasName,
            scope: findEnclosingScope(node),
            ctx,
          });
        }
      }
    }
    if (ts.isParameter(node) && node.name && ts.isIdentifier(node.name) && node.name.text === 't') {
      const ctx = tFunctionParamContext(node);
      if (ctx) {
        bindings.push({
          start: node.getStart(sourceFile),
          aliasName: 't',
          scope: findEnclosingScope(node),
          ctx,
        });
      }
    }
    ts.forEachChild(node, visitBindings);
  }

  visitBindings(sourceFile);

  function visitCalls(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        const arg = node.arguments[0];
        let ctx = findApplicableCtx(node, callee.text);
        // Only treat the call as an i18n call if either (a) we resolved a
        // binding for this identifier, or (b) the identifier is literally
        // named `t` — heuristic that catches helpers receiving `t` without
        // an importable type annotation we could parse.
        if (!ctx && callee.text === 't') {
          ctx = ANY_CTX;
        }
        if (ctx && arg) {
          if (!resolveArgument(arg, ctx) && (callee.text === 't' || ctx !== ANY_CTX)) {
            const start = arg.getStart(sourceFile);
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
            unanalyzable.push({
              file: filePath,
              line: line + 1,
              column: character + 1,
              snippet: arg.getText(sourceFile).slice(0, 80),
            });
          }
        }
      }
    }

    // Object properties whose name ends in `I18nKey` are conventional
    // i18n-key holders (e.g. `titleI18nKey: 'library.smart.fiveStars.title'`).
    // The values get passed to `t(preset.titleI18nKey)` elsewhere, which the
    // linter can't statically follow. Record the literal value as referenced
    // in every namespace so the catalog entry is considered live.
    if (ts.isPropertyAssignment(node)) {
      const name = node.name;
      let propertyName: string | undefined;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        propertyName = name.text;
      }
      if (propertyName && propertyName.endsWith('I18nKey')) {
        const init = node.initializer;
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
          resolveStaticKey(init.text, ANY_CTX, init);
        }
      }
    }

    if (ts.isJsxAttribute(node) && jsxAttributeName(node) === 'i18nKey') {
      const initializer = node.initializer;
      let key: string | undefined;
      if (initializer) {
        if (ts.isStringLiteral(initializer)) {
          key = initializer.text;
        } else if (ts.isJsxExpression(initializer) && initializer.expression) {
          const expr = initializer.expression;
          if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
            key = expr.text;
          }
        }
      }
      if (key) {
        const opening = findEnclosingJsxOpening(node);
        let tName = 't';
        if (opening) {
          for (const attr of opening.attributes.properties) {
            if (!ts.isJsxAttribute(attr)) continue;
            if (jsxAttributeName(attr) !== 't') continue;
            const init = attr.initializer;
            if (init && ts.isJsxExpression(init) && init.expression && ts.isIdentifier(init.expression)) {
              tName = init.expression.text;
            }
          }
        }
        const ctx = findApplicableCtx(node, tName) ?? ANY_CTX;
        resolveStaticKey(key, ctx, node);
      }
    }

    ts.forEachChild(node, visitCalls);
  }

  visitCalls(sourceFile);

  for (const line of source.split('\n')) {
    const idx = line.indexOf(KEEP_MARKER);
    if (idx === -1) continue;
    const after = line.slice(idx + KEEP_MARKER.length).trim();
    if (!after) continue;
    const token = after.split(/\s/)[0];
    if (token) keepHints.add(token);
  }

  return { usedKeys, globs, references, referencedNamespaces, unanalyzable, keepHints };
}

type Orphan = { namespace: string; key: string };

function isReferenced(
  namespace: string,
  key: string,
  used: Set<string>,
  patterns: GlobPattern[],
  anyUsed: Set<string>,
  anyGlobs: GlobPattern[],
): boolean {
  if (used.has(key) || anyUsed.has(key)) return true;
  for (const pattern of patterns) {
    if (globMatchesKey(pattern, key)) return true;
  }
  for (const pattern of anyGlobs) {
    if (globMatchesKey(pattern, key)) return true;
  }
  return false;
}

function computeOrphans(
  catalog: Map<string, Set<string>>,
  usedKeys: Map<string, Set<string>>,
  globs: Map<string, GlobPattern[]>,
  keepHints: Set<string>,
): Orphan[] {
  const orphans: Orphan[] = [];
  const anyUsed = usedKeys.get(ANY_NAMESPACE) ?? new Set<string>();
  const anyGlobs = globs.get(ANY_NAMESPACE) ?? [];

  for (const [namespace, keys] of catalog) {
    const used = usedKeys.get(namespace) ?? new Set<string>();
    const namespaceGlobs = globs.get(namespace) ?? [];

    for (const key of keys) {
      if (keepHints.has(`${namespace}.${key}`) || keepHints.has(`${namespace}:${key}`)) continue;
      if (isReferenced(namespace, key, used, namespaceGlobs, anyUsed, anyGlobs)) continue;

      // Plural variants: `<base>_one`, `<base>_other`, etc. count as
      // referenced when the base key is referenced.
      const base = pluralBaseKey(key);
      if (base && isReferenced(namespace, base, used, namespaceGlobs, anyUsed, anyGlobs)) continue;

      orphans.push({ namespace, key });
    }
  }
  orphans.sort((a, b) => {
    if (a.namespace !== b.namespace) return a.namespace.localeCompare(b.namespace);
    return a.key.localeCompare(b.key);
  });
  return orphans;
}

type MissingKey = { namespaces: readonly string[]; key: string; file: string; line: number; column: number };
type ForeignMobileNamespace = { namespace: string; file: string };

const MOBILE_PATH_MARKER = '/packages/mobile/';

function isMobileFile(filePath: string): boolean {
  return filePath.split(sep).join('/').includes(MOBILE_PATH_MARKER);
}

/**
 * Does the catalog define this key? i18next resolves a `t('items', { count })`
 * call against the suffixed forms (`items_one`, `items_other`, …) and the
 * catalog only ever stores those, so the bare base counts as defined when any
 * variant — plain or ordinal — is present.
 */
function catalogHasKey(catalog: Map<string, Set<string>>, namespace: string, key: string): boolean {
  const keys = catalog.get(namespace);
  if (!keys) return false;
  if (keys.has(key)) return true;
  for (const suffix of PLURAL_SUFFIXES) {
    if (keys.has(`${key}${suffix}`)) return true;
    if (keys.has(`${key}_ordinal${suffix}`)) return true;
  }
  return false;
}

/**
 * The inverse of `computeOrphans`: every statically-resolved reference whose key
 * exists in none of its candidate namespaces. That is the #4416 failure mode —
 * i18next renders the raw key string into the UI.
 *
 * Leniency, so this can never redden CI for code that actually works:
 *   - a reference the AST couldn't bind to a namespace (ANY_NAMESPACE) counts as
 *     defined when the key exists in *any* namespace;
 *   - a multi-namespace binding counts as defined when *any* bound namespace has it;
 *   - plural variants count (see `catalogHasKey`);
 *   - template-literal globs are never recorded as references, so `prefix.${x}`
 *     is skipped rather than guessed at.
 */
function computeMissingKeys(catalog: Map<string, Set<string>>, references: readonly KeyReference[]): MissingKey[] {
  const missing: MissingKey[] = [];
  const seen = new Set<string>();

  for (const reference of references) {
    const anyNamespace = reference.namespaces.includes(ANY_NAMESPACE);
    const candidates = anyNamespace ? [...catalog.keys()] : reference.namespaces;
    const defined = candidates.some((namespace) => catalogHasKey(catalog, namespace, reference.key));
    if (defined) continue;

    const namespaces = anyNamespace ? [ANY_NAMESPACE] : reference.namespaces;
    const dedupeKey = `${namespaces.join(',')}|${reference.key}|${reference.file}|${reference.line}|${reference.column}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    missing.push({
      namespaces,
      key: reference.key,
      file: reference.file,
      line: reference.line,
      column: reference.column,
    });
  }

  missing.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    return a.key.localeCompare(b.key);
  });
  return missing;
}

/**
 * Namespaces read from a file under `packages/mobile/` that Metro never bundles,
 * because `MOBILE_NAMESPACES` leaves them out. Those keys resolve on web and
 * render raw on device, so the bug only shows up in a store build.
 */
function computeForeignMobileNamespaces(
  namespacesByFile: ReadonlyMap<string, ReadonlySet<string>>,
): ForeignMobileNamespace[] {
  const foreign: ForeignMobileNamespace[] = [];
  const mobileNamespaces = new Set<string>(MOBILE_NAMESPACES);
  for (const [file, namespaces] of namespacesByFile) {
    if (!isMobileFile(file)) continue;
    for (const namespace of namespaces) {
      if (mobileNamespaces.has(namespace)) continue;
      foreign.push({ namespace, file });
    }
  }
  foreign.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.namespace.localeCompare(b.namespace);
  });
  return foreign;
}

type Report = {
  totalFiles: number;
  totalKeys: number;
  totalReferences: number;
  orphans: Orphan[];
  missing: MissingKey[];
  foreignMobileNamespaces: ForeignMobileNamespace[];
  unanalyzable: UnanalyzableSite[];
};

function run(): Report {
  const namespaces = discoverNamespaces();
  const catalog = loadCatalog(namespaces);
  const files = discoverFiles([appRoot, scriptsRoot, mobileSrcRoot, mobileAppRoot]);
  const usedKeys = new Map<string, Set<string>>();
  const globs = new Map<string, GlobPattern[]>();
  const references: KeyReference[] = [];
  const namespacesByFile = new Map<string, ReadonlySet<string>>();
  const unanalyzable: UnanalyzableSite[] = [];
  const keepHints = new Set<string>();

  for (const file of files) {
    const analysis = analyzeFile(file);
    references.push(...analysis.references);
    namespacesByFile.set(file, analysis.referencedNamespaces);
    for (const [ns, keys] of analysis.usedKeys) {
      let target = usedKeys.get(ns);
      if (!target) {
        target = new Set();
        usedKeys.set(ns, target);
      }
      for (const key of keys) target.add(key);
    }
    for (const [ns, patterns] of analysis.globs) {
      let target = globs.get(ns);
      if (!target) {
        target = [];
        globs.set(ns, target);
      }
      target.push(...patterns);
    }
    unanalyzable.push(...analysis.unanalyzable);
    for (const hint of analysis.keepHints) keepHints.add(hint);
  }

  let totalKeys = 0;
  for (const keys of catalog.values()) totalKeys += keys.size;

  const orphans = computeOrphans(catalog, usedKeys, globs, keepHints);
  const missing = computeMissingKeys(catalog, references);
  const foreignMobileNamespaces = computeForeignMobileNamespaces(namespacesByFile);
  return {
    totalFiles: files.length,
    totalKeys,
    totalReferences: references.length,
    orphans,
    missing,
    foreignMobileNamespaces,
    unanalyzable,
  };
}

function describeNamespaces(namespaces: readonly string[]): string {
  if (namespaces.includes(ANY_NAMESPACE)) return 'any namespace';
  if (namespaces.length === 1) return namespaces[0];
  return namespaces.join(' | ');
}

function formatReport(report: Report): { exitCode: 0 | 1; lines: string[] } {
  const lines: string[] = [];
  const hasUnanalyzable = report.unanalyzable.length > 0;
  const hasOrphans = report.orphans.length > 0;
  const hasMissing = report.missing.length > 0;
  const hasForeignMobileNamespaces = report.foreignMobileNamespaces.length > 0;

  if (hasUnanalyzable) {
    for (const site of report.unanalyzable) {
      const rel = relative(repoRoot, site.file);
      lines.push(`${rel}:${site.line}:${site.column}  unanalyzable t() argument: ${site.snippet}`);
    }
    lines.push('');
    lines.push(`Found ${report.unanalyzable.length} t() call(s) with a non-static key argument.`);
    lines.push(
      'Inline the key as a string literal, switch to a template literal we can statically analyse, or add `// i18n-keep namespace.key.path` for every key the dynamic call could resolve to.',
    );
  }

  if (hasOrphans) {
    if (hasUnanalyzable) lines.push('');
    let lastNamespace = '';
    for (const orphan of report.orphans) {
      if (orphan.namespace !== lastNamespace) {
        if (lastNamespace !== '') lines.push('');
        lines.push(`packages/shared/i18n/locales/en-US/${orphan.namespace}.json`);
        lastNamespace = orphan.namespace;
      }
      lines.push(`  ${orphan.key}`);
    }
    lines.push('');
    lines.push(
      `Found ${report.orphans.length} orphaned key(s) across ${new Set(report.orphans.map((orphan) => orphan.namespace)).size} namespace(s).`,
    );
    lines.push(
      'Delete each from every locale catalog (en-US, es, fr, de) or add `// i18n-keep namespace.key.path` if the key is referenced outside the scanned web + mobile source.',
    );
  }

  if (hasMissing) {
    if (hasUnanalyzable || hasOrphans) lines.push('');
    for (const entry of report.missing) {
      const rel = relative(repoRoot, entry.file);
      lines.push(
        `${rel}:${entry.line}:${entry.column}  missing key: ${describeNamespaces(entry.namespaces)} -> ${entry.key}`,
      );
    }
    lines.push('');
    lines.push(`Found ${report.missing.length} reference(s) to key(s) that exist in no catalog.`);
    lines.push(
      "i18next renders the raw key when it can't resolve one, so each of these ships as visible gibberish. Add the key to all four locale catalogs (en-US, es, fr, de) or point the call at a key that already exists.",
    );
  }

  if (hasForeignMobileNamespaces) {
    if (hasUnanalyzable || hasOrphans || hasMissing) lines.push('');
    for (const entry of report.foreignMobileNamespaces) {
      const rel = relative(repoRoot, entry.file);
      lines.push(`${rel}  reads namespace '${entry.namespace}', which is not bundled on mobile`);
    }
    lines.push('');
    lines.push(
      `Found ${report.foreignMobileNamespaces.length} mobile file(s) reading a namespace outside MOBILE_NAMESPACES.`,
    );
    lines.push(
      'Metro only bundles the MOBILE_NAMESPACES subset, so every key in those namespaces renders raw on device. Move the copy into a bundled namespace, or add the namespace to MOBILE_NAMESPACES in packages/shared/i18n/src/config.ts.',
    );
  }

  if (hasOrphans || hasUnanalyzable || hasMissing || hasForeignMobileNamespaces) {
    return { exitCode: 1, lines };
  }

  lines.push(
    `check-orphaned-i18n-keys: OK — scanned ${report.totalFiles} source file(s): every one of ${report.totalKeys} catalog key(s) has a live reference, and all ${report.totalReferences} static key reference(s) resolve to a catalog entry in a mobile-safe namespace.`,
  );
  return { exitCode: 0, lines };
}

function main(): never {
  const report = run();
  const formatted = formatReport(report);
  const stream = formatted.exitCode === 0 ? console.info : console.error;
  for (const line of formatted.lines) stream(line);
  process.exit(formatted.exitCode);
}

function isEntryPoint(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}

export {
  analyzeFile,
  computeForeignMobileNamespaces,
  computeMissingKeys,
  computeOrphans,
  discoverFiles,
  formatReport,
  isExcluded,
  loadCatalog,
  run,
};
export { appRoot, mobileAppRoot, mobileSrcRoot, scriptsRoot };
export type { ForeignMobileNamespace, KeyReference, MissingKey, Orphan, Report };
