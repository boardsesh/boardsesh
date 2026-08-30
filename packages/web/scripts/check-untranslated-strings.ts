#!/usr/bin/env node
/**
 * Static check that fails when a `.tsx` file under `packages/web/app/`
 * introduces a hardcoded user-facing English string. New copy must go
 * through `t(...)` (or `<Trans>`) so the `/es/*` locale renders correctly.
 *
 * What gets flagged:
 *   1. JSX text nodes      e.g. <Button>Save</Button>
 *   2. Specific JSX string-literal attributes (aria-label, placeholder,
 *      title, alt, helperText, label, description, tooltip, primary,
 *      secondary, aria-description, aria-placeholder, aria-roledescription,
 *      okText, cancelText)
 *   3. Imperative call sites: enqueueSnackbar / showMessage / openAuthModal
 *      with a literal message arg or a literal title/description/body/message
 *      object property
 *
 * What's silently allowed (content filter, not an exemption list):
 *   - empty / whitespace-only strings
 *   - strings without 2+ consecutive ASCII letters
 *   - strings shorter than 4 chars that don't contain a space
 *   - URL/email/tel/anchor/path-looking strings
 *   - JSX content nested inside <pre>, <code>, <script>, <style>
 *
 * Per-site opt-out: `// i18n-ignore-next-line` (or the JSX-comment form
 * `{/* i18n-ignore-next-line *\/}`) on the line directly above the
 * offending node. One marker silences exactly one violation. Markers that
 * don't actually suppress anything emit a warning so they don't rot.
 */
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// TypeScript 7 ships no compiler API — see the note in check-orphaned-i18n-keys.ts.
import ts from 'typescript-compiler-api';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const appRoot = join(webRoot, 'app');
const repoRoot = join(webRoot, '..', '..');

const FLAGGED_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'placeholder',
  'title',
  'alt',
  'helperText',
  'label',
  'description',
  'tooltip',
  'primary',
  'secondary',
  'okText',
  'cancelText',
]);

// Map of call name → which positional arguments to scan. For toast-style
// helpers only the first argument is the human message (subsequent args are
// severity/options literals like "error", "info"). Modal openers receive a
// config object — see FLAGGED_CALL_OBJECT.
const FLAGGED_CALL_POSITIONAL = new Map<string, number[]>([
  ['enqueueSnackbar', [0]],
  ['showMessage', [0]],
]);
const FLAGGED_CALL_OBJECT = new Set(['enqueueSnackbar', 'showMessage', 'openAuthModal']);
const FLAGGED_CALL_OBJECT_KEYS = new Set(['title', 'description', 'body', 'message']);
// Tags whose JSX text children are not raw user-facing prose.
//   pre/code/script/style — code samples and embedded markup
//   Trans               — react-i18next inline translation; children are
//                         the English fallback for the i18n key
const SKIP_TEXT_INSIDE_TAGS = new Set(['pre', 'code', 'script', 'style', 'Trans']);

const IGNORE_MARKER = 'i18n-ignore-next-line';

type Violation = {
  file: string;
  line: number;
  column: number;
  kind: 'jsx-text' | 'jsx-attribute' | 'call-arg' | 'call-object-prop';
  attribute?: string;
  caller?: string;
  text: string;
};

function isExcluded(absolutePath: string, root: string = repoRoot): boolean {
  const relativePath = relative(root, absolutePath);
  const normalized = `/${relativePath.split(sep).join('/')}`;
  if (normalized.includes('/node_modules/')) return true;
  if (normalized.includes('/.next/')) return true;
  if (normalized.includes('/dist/')) return true;
  if (normalized.includes('/generated/')) return true;
  if (normalized.includes('/__tests__/')) return true;
  if (normalized.endsWith('.test.tsx')) return true;
  if (normalized.endsWith('.spec.tsx')) return true;
  if (normalized.endsWith('.stories.tsx')) return true;
  return false;
}

function discoverFiles(): string[] {
  const entries = readdirSync(appRoot, { recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativeEntry = typeof entry === 'string' ? entry : entry.toString();
    if (!relativeEntry.endsWith('.tsx')) continue;
    const full = join(appRoot, relativeEntry);
    if (isExcluded(full)) continue;
    files.push(full);
  }
  return files;
}

const URL_LIKE = /^(?:https?:\/\/|mailto:|tel:|ftp:|\/\/[a-zA-Z0-9-])/i;
const PATH_LIKE = /^(?:\.{1,2}\/|\/[a-zA-Z0-9_-]+\/?$)/;
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const PURE_PUNCT_NUM = /^[\s\d\p{P}\p{S}]+$/u;
const HAS_TWO_LETTERS = /[A-Za-z]{2}/;

function looksTranslatable(raw: string): boolean {
  const text = raw.trim();
  if (text.length === 0) return false;
  if (PURE_PUNCT_NUM.test(text)) return false;
  if (!HAS_TWO_LETTERS.test(text)) return false;
  if (URL_LIKE.test(text)) return false;
  if (PATH_LIKE.test(text)) return false;
  if (HEX_COLOR.test(text)) return false;
  if (text.length < 4 && !text.includes(' ')) return false;
  return true;
}

function isInsideExemptElement(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isJsxElement(current)) {
      const tagName = current.openingElement.tagName;
      if (ts.isIdentifier(tagName) && SKIP_TEXT_INSIDE_TAGS.has(tagName.text)) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function isTranslationExpression(expr: ts.Expression | undefined): boolean {
  if (!expr) return false;
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (ts.isIdentifier(callee) && callee.text === 't') return true;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 't') return true;
  }
  return false;
}

type IgnoreIndex = {
  pendingLines: Set<number>;
  used: Set<number>;
  // Map<markerLine, targetLine> so the stale check knows which line should
  // have been suppressed even when trivia lines sit between the marker and
  // the violation (e.g. oxfmt may expand `{/* foo */}` into 3 lines).
  markerToTarget: Map<number, number>;
};

function buildIgnoreIndex(source: string): IgnoreIndex {
  // Source-text scan is intentionally line-based: it catches every form
  // (// i18n-ignore-next-line, /* i18n-ignore-next-line */ inside a JSX
  // expression) without having to navigate around AST quirks for JSX
  // comments. A marker on line N suppresses violations on the next non-
  // trivia line (skipping over braces, blank lines, and JSX-comment
  // continuations the formatter may have wrapped onto separate lines).
  const pendingLines = new Set<number>();
  const markerToTarget = new Map<number, number>();
  const lines = source.split('\n');

  const isTriviaLine = (lineText: string): boolean => {
    const trimmed = lineText.trim();
    if (trimmed === '') return true;
    if (trimmed === '{' || trimmed === '}' || trimmed === '{}') return true;
    if (trimmed === '/*' || trimmed === '*/' || trimmed === '*/}') return true;
    if (trimmed.startsWith('*')) return true;
    if (trimmed.includes(IGNORE_MARKER)) return true;
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(IGNORE_MARKER)) continue;
    let target = i + 1;
    while (target < lines.length && isTriviaLine(lines[target])) {
      target += 1;
    }
    if (target < lines.length) {
      pendingLines.add(target);
      markerToTarget.set(i, target);
    } else {
      markerToTarget.set(i, -1);
    }
  }

  return { pendingLines, used: new Set(), markerToTarget };
}

function chooseIgnoreCommentText(violation: Violation, lineText: string, previousLineText: string): string {
  const indent = lineText.match(/^\s*/)?.[0] ?? '';
  const trimmed = lineText.trimStart();
  const previousTrimmedEnd = previousLineText.trimEnd();

  // Object-literal properties inside a function call (e.g. openAuthModal({
  // title: 'foo' })): the marker line goes between object keys, where
  // {/* … */} is a syntax error. Use a JS line comment — also valid trivia
  // between attributes inside a multi-line JSX opening tag.
  if (violation.kind === 'call-object-prop') {
    return `${indent}// i18n-ignore-next-line`;
  }
  if (violation.kind === 'jsx-attribute') {
    const attr = violation.attribute ?? '';
    if (trimmed.startsWith(attr)) {
      return `${indent}// i18n-ignore-next-line`;
    }
  }

  // JSX expression inside parens-wrapped expression (`return ( <Tag /> )`,
  // ternary branches, conditional renders): {/* */} would parse as `{}`
  // ahead of the JSX expression and break the surrounding expression. A JS
  // line comment is valid trivia between `(` and the expression.
  if (previousTrimmedEnd.endsWith('(') || previousTrimmedEnd.endsWith('?') || previousTrimmedEnd.endsWith(':')) {
    return `${indent}// i18n-ignore-next-line`;
  }

  // JSX text and lines whose first character is `<` (start of a JSX
  // element nested inside another JSX element) or `{` (a JsxExpression
  // child like `{cond && <Chip />}`) live in JSX-child position; use the
  // JsxExpression form. A bare `//` comment in JSX-child position would
  // render as visible DOM text. For straight JS lines (e.g.
  // `showMessage(…)` in a function body), use a line comment to avoid
  // emitting a stray empty block.
  if (violation.kind === 'jsx-text' || trimmed.startsWith('<') || trimmed.startsWith('{')) {
    return `${indent}{/* i18n-ignore-next-line */}`;
  }
  return `${indent}// i18n-ignore-next-line`;
}

function applyFixes(filePath: string, violations: Violation[]): boolean {
  if (violations.length === 0) return false;
  const source = readFileSync(filePath, 'utf8');
  const lines = source.split('\n');

  // One marker silences every violation on the same line.
  const byLine = new Map<number, Violation>();
  for (const violation of violations) {
    if (!byLine.has(violation.line)) byLine.set(violation.line, violation);
  }

  // Insert markers from bottom up so earlier line numbers don't shift.
  const sortedLines = [...byLine.keys()].sort((a, b) => b - a);
  for (const violationLine of sortedLines) {
    const violation = byLine.get(violationLine);
    if (!violation) continue;
    const previousLine = lines[violationLine - 2] ?? '';
    if (previousLine.includes(IGNORE_MARKER)) continue;
    const violationLineText = lines[violationLine - 1] ?? '';
    const markerText = chooseIgnoreCommentText(violation, violationLineText, previousLine);
    lines.splice(violationLine - 1, 0, markerText);
  }

  const newSource = lines.join('\n');
  if (newSource === source) return false;
  writeFileSync(filePath, newSource);
  return true;
}

function consumeIgnoreFor(line: number, ignoreIndex: IgnoreIndex): boolean {
  if (ignoreIndex.pendingLines.has(line)) {
    ignoreIndex.used.add(line);
    return true;
  }
  return false;
}

function trimJsxText(rawText: string): string {
  const collapsed = rawText.replace(/\s+/g, ' ').trim();
  return collapsed;
}

function checkFile(filePath: string, sourceOverride?: string): { violations: Violation[]; staleMarkers: number[] } {
  const source = sourceOverride ?? readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];
  const ignoreIndex = buildIgnoreIndex(source);

  function record(violation: Violation, anchorLine: number) {
    if (consumeIgnoreFor(anchorLine, ignoreIndex)) return;
    violations.push(violation);
  }

  function visit(node: ts.Node) {
    if (ts.isJsxText(node)) {
      const trimmed = trimJsxText(node.text);
      if (looksTranslatable(trimmed) && !isInsideExemptElement(node)) {
        const start = node.getStart(sourceFile);
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
        record(
          {
            file: filePath,
            line: line + 1,
            column: character + 1,
            kind: 'jsx-text',
            text: trimmed,
          },
          line,
        );
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (FLAGGED_ATTRIBUTES.has(name)) {
        const literalText = extractStringLiteral(node.initializer);
        if (literalText !== undefined && looksTranslatable(literalText)) {
          const start = node.getStart(sourceFile);
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
          record(
            {
              file: filePath,
              line: line + 1,
              column: character + 1,
              kind: 'jsx-attribute',
              attribute: name,
              text: literalText,
            },
            line,
          );
        }
      }
    } else if (ts.isCallExpression(node)) {
      const calleeName = getCalleeName(node);
      if (calleeName) {
        const positional = FLAGGED_CALL_POSITIONAL.get(calleeName);
        if (positional) {
          for (const index of positional) {
            const arg = node.arguments[index];
            if (!arg) continue;
            if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
              if (looksTranslatable(arg.text)) {
                const start = arg.getStart(sourceFile);
                const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
                record(
                  {
                    file: filePath,
                    line: line + 1,
                    column: character + 1,
                    kind: 'call-arg',
                    caller: calleeName,
                    text: arg.text,
                  },
                  line,
                );
              }
            }
          }
        }
        if (FLAGGED_CALL_OBJECT.has(calleeName)) {
          for (const arg of node.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue;
            for (const prop of arg.properties) {
              if (!ts.isPropertyAssignment(prop)) continue;
              const propName = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : undefined;
              if (!propName || !FLAGGED_CALL_OBJECT_KEYS.has(propName)) continue;
              const init = prop.initializer;
              if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
                if (looksTranslatable(init.text)) {
                  const start = init.getStart(sourceFile);
                  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
                  record(
                    {
                      file: filePath,
                      line: line + 1,
                      column: character + 1,
                      kind: 'call-object-prop',
                      caller: calleeName,
                      attribute: propName,
                      text: init.text,
                    },
                    line,
                  );
                }
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const staleMarkers: number[] = [];
  for (const [markerLine, targetLine] of ignoreIndex.markerToTarget) {
    if (targetLine < 0 || !ignoreIndex.used.has(targetLine)) {
      staleMarkers.push(markerLine + 1);
    }
  }

  return { violations, staleMarkers };
}

function extractStringLiteral(initializer: ts.JsxAttributeValue | undefined): string | undefined {
  if (!initializer) return undefined;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer)) {
    const expr = initializer.expression;
    if (!expr) return undefined;
    if (isTranslationExpression(expr)) return undefined;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  }
  return undefined;
}

function getCalleeName(node: ts.CallExpression): string | undefined {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

type Report = {
  totalFiles: number;
  filesWithViolations: number;
  totalViolations: number;
  staleMarkers: { file: string; line: number }[];
  violations: Violation[];
};

function run(): Report {
  const files = discoverFiles();
  const violations: Violation[] = [];
  const staleMarkers: { file: string; line: number }[] = [];
  const filesWithViolations = new Set<string>();

  for (const file of files) {
    const result = checkFile(file);
    if (result.violations.length > 0) {
      filesWithViolations.add(file);
      violations.push(...result.violations);
    }
    for (const line of result.staleMarkers) {
      staleMarkers.push({ file, line });
    }
  }

  return {
    totalFiles: files.length,
    filesWithViolations: filesWithViolations.size,
    totalViolations: violations.length,
    staleMarkers,
    violations,
  };
}

function describe(violation: Violation): string {
  const rel = relative(repoRoot, violation.file);
  const head = `${rel}:${violation.line}:${violation.column}`;
  if (violation.kind === 'jsx-text') {
    return `${head}  hardcoded user-facing string: ${JSON.stringify(violation.text)}`;
  }
  if (violation.kind === 'jsx-attribute') {
    return `${head}  hardcoded ${violation.attribute}: ${JSON.stringify(violation.text)}`;
  }
  if (violation.kind === 'call-arg') {
    return `${head}  hardcoded ${violation.caller}() arg: ${JSON.stringify(violation.text)}`;
  }
  return `${head}  hardcoded ${violation.caller}({ ${violation.attribute} }): ${JSON.stringify(violation.text)}`;
}

function formatReport(report: Report): { exitCode: 0 | 1; stderr: string[]; stdout: string[] } {
  const hasViolations = report.violations.length > 0;
  const hasStaleMarkers = report.staleMarkers.length > 0;
  const stderr: string[] = [];
  const stdout: string[] = [];

  if (hasViolations) {
    for (const violation of report.violations) {
      stderr.push(describe(violation));
    }
    stderr.push('');
    stderr.push(
      `Found ${report.totalViolations} hardcoded user-facing string(s) in ${report.filesWithViolations} file(s).`,
    );
    stderr.push(
      "Wrap each in t('namespace:key') (see CLAUDE.md i18n section) or add " +
        '`// i18n-ignore-next-line` on the line above to mark it as deliberately untranslated. ' +
        'Run `tsx packages/web/scripts/check-untranslated-strings.ts --fix` to bulk-add markers above existing violations.',
    );
  }

  if (hasStaleMarkers) {
    if (hasViolations) stderr.push('');
    for (const stale of report.staleMarkers) {
      const rel = relative(repoRoot, stale.file);
      stderr.push(`${rel}:${stale.line}  stale i18n-ignore-next-line marker (no violation on the next line)`);
    }
    stderr.push('');
    stderr.push(`Found ${report.staleMarkers.length} stale i18n-ignore-next-line marker(s); remove them.`);
  }

  if (hasViolations || hasStaleMarkers) {
    return { exitCode: 1, stderr, stdout };
  }

  stdout.push(
    `check-untranslated-strings: OK — scanned ${report.totalFiles} .tsx file(s), no hardcoded user-facing strings.`,
  );
  return { exitCode: 0, stderr, stdout };
}

function main(): never {
  const fixMode = process.argv.includes('--fix');

  if (fixMode) {
    const files = discoverFiles();
    let fixedFiles = 0;
    let fixedViolations = 0;
    for (const file of files) {
      const result = checkFile(file);
      if (result.violations.length === 0) continue;
      const wrote = applyFixes(file, result.violations);
      if (wrote) {
        fixedFiles += 1;
        const lineCount = new Set(result.violations.map((violation) => violation.line)).size;
        fixedViolations += lineCount;
      }
    }
    console.info(
      `check-untranslated-strings --fix: inserted i18n-ignore-next-line markers above ${fixedViolations} line(s) in ${fixedFiles} file(s).`,
    );
    console.info('Re-run without --fix to verify, then translate the marked lines and remove the markers.');
    process.exit(0);
  }

  const report = run();
  const formatted = formatReport(report);
  for (const line of formatted.stderr) console.error(line);
  for (const line of formatted.stdout) console.info(line);
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

export { applyFixes, checkFile, discoverFiles, formatReport, isExcluded, looksTranslatable, run };
export type { Report, Violation };
