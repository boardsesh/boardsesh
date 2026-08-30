/// <reference types="node" />

/**
 * Guards against an ABI skew between the dynamic frameworks embedded in the
 * built iOS app — the failure mode that shipped TestFlight 2.4.0 (2), which
 * aborted in dyld before a single line of JavaScript ran:
 *
 *   Symbol not found: _$s14ExpoModulesJSI15JavaScriptActorC14assumeIsolated...
 *   Referenced from: .../Frameworks/ExpoModulesCore.framework/ExpoModulesCore
 *   Expected in:     .../Frameworks/ExpoModulesJSI.framework/ExpoModulesJSI
 *
 * How that got past every gate: Expo's precompiled modules are on by default
 * (the generated Podfile sets EXPO_USE_PRECOMPILED_MODULES ||= 1), so
 * ExpoModulesCore arrives as a DOWNLOADED xcframework while ExpoModulesJSI is
 * compiled locally from whatever `expo-modules-jsi` the lockfile resolved. A
 * prebuilt framework's undefined symbols are never re-validated by the linker —
 * Xcode just rsyncs and codesigns it — so only dyld, at launch on a device,
 * ever discovers that the pair disagrees. `expo-modules-core@57.0.11` pinned
 * `expo-modules-jsi: ~57.0.4`, jsi 57.0.6 turned `assumeIsolated` into an
 * `@_alwaysEmitIntoClient` inline (deleting the exported symbol), and the
 * lockfile floated onto it. Every manifest was self-consistent; the break
 * existed only in the Mach-O.
 *
 * So this check reads the compiled product. For every Mach-O in the app, `nm`
 * reports each undefined symbol together with the library dyld will bind it
 * against — the two-level namespace `(from X)` clause. When X is a framework
 * embedded in this same app, X must actually export that symbol. That is
 * precisely the invariant dyld enforces at launch, asserted at build time.
 *
 * Matching on the `(from X)` leaf name is what keeps this hermetic: no @rpath
 * resolution, no SDK, no .tbd stubs, no simulator. Anything binding to a system
 * dylib is out of scope by construction — we only ever open files inside the
 * .app.
 *
 * Usage: vp run mobile:abi-check -- --app <path-to-.app>
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Symbols that are allowed to be missing from the framework they name.
 *
 * The one legitimate source of a false positive is LC_REEXPORT_DYLIB: a
 * framework can re-export a symbol it does not itself define, so `nm` names it
 * as the source while the definition lives one hop further on. That is rare in
 * the Expo/RN graph and indistinguishable from a real break without walking the
 * re-export chain, so it is handled by exception rather than by weakening the
 * rule — a warn-only check would have let 2.4.0 (2) ship. When adding an entry,
 * record which framework re-exports it and why.
 */
const ALLOWED_MISSING_SYMBOLS: readonly string[] = [];

/** One Mach-O's symbols, as parsed from `nm -m` output. */
export interface SymbolTable {
  /** Exported symbols other binaries can bind against. */
  defined: Set<string>;
  /** Undefined symbols this binary needs at load time. */
  imports: UndefinedSymbol[];
}

export interface UndefinedSymbol {
  name: string;
  /** Leaf name from the `(from X)` clause; null for flat-namespace/dynamic lookup. */
  fromLibrary: string | null;
  /** Weak imports resolve to NULL when absent, so they are never a break. */
  weak: boolean;
}

export interface AbiBreak {
  /** Binary that references the symbol. */
  client: string;
  symbol: string;
  /** Framework dyld would bind it against. */
  expectedIn: string;
  /**
   * Other embedded frameworks that DO define it. Non-empty usually means a
   * re-export rather than a genuine skew — see ALLOWED_MISSING_SYMBOLS.
   */
  definedElsewhere: string[];
}

/**
 * Reads one `nm -arch arm64 -m` listing. Pure — no I/O.
 *
 * Both halves of the comparison come out of this single format, which is why
 * the check shells out once per binary instead of pairing `nm -u` with
 * `nm -gU`. Lines look like:
 *
 *   0000000000004a10 (__TEXT,__text) external _$s14ExpoModulesJSI...
 *                    (undefined) external _foo (from ExpoModulesJSI)
 *                    (undefined) weak external _bar (from CoreFoundation)
 *                    (undefined) external _baz (from dynamic lookup)
 *                    0000000000001234 (__DATA,__const) non-external _qux
 */
export function parseNmOutput(nmOutput: string): SymbolTable {
  const defined = new Set<string>();
  const imports: UndefinedSymbol[] = [];

  for (const rawLine of nmOutput.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') continue;

    // Strip the trailing source-library clause before tokenizing, so a symbol
    // name can never be confused with it.
    const fromClause = line.match(/\s\(from ([^)]+)\)$/);
    const body = fromClause ? line.slice(0, line.length - fromClause[0].length) : line;

    const tokens = body.trim().split(/\s+/);
    if (tokens.length < 2) continue;

    const name = tokens[tokens.length - 1];
    const descriptor = tokens.slice(0, -1).join(' ');

    if (descriptor.includes('(undefined)')) {
      const library = fromClause ? fromClause[1] : null;
      imports.push({
        name,
        // "dynamic lookup" is the flat-namespace escape hatch: no library is
        // named, so there is nothing to assert against.
        fromLibrary: library === null || library === 'dynamic lookup' ? null : library,
        weak: /(?:^|\s)weak(?:\s|$)/.test(descriptor),
      });
      continue;
    }

    // `non-external` and `private external` both contain the token `external`,
    // and neither is bindable from another image.
    if (/(?:^|\s)non-external(?:\s|$)/.test(descriptor)) continue;
    if (/(?:^|\s)private external(?:\s|$)/.test(descriptor)) continue;
    if (/(?:^|\s)external(?:\s|$)/.test(descriptor)) defined.add(name);
  }

  return { defined, imports };
}

export interface AbiCheckResult {
  /**
   * Undefined symbols actually compared against an embedded framework. Zero
   * means the check validated nothing and must not report success.
   */
  checkedEdges: number;
  breaks: AbiBreak[];
}

/**
 * The whole check. Pure — `tables` is keyed by the name `nm` uses in its
 * `(from X)` clause, which for a framework is its binary's file name.
 */
export function findAbiBreaks(
  tables: ReadonlyMap<string, SymbolTable>,
  allowlist: readonly string[] = ALLOWED_MISSING_SYMBOLS,
): AbiCheckResult {
  const allowed = new Set(allowlist);
  const breaks: AbiBreak[] = [];
  let checkedEdges = 0;

  // A dylib is registered under both spellings nm might use (`libfoo.dylib` and
  // `libfoo`) so provider lookup matches either. Both names share one table, so
  // dedupe by identity or every finding is reported twice.
  const inspected = new Set<SymbolTable>();

  for (const [client, table] of tables) {
    if (inspected.has(table)) continue;
    inspected.add(table);

    for (const imported of table.imports) {
      if (imported.weak) continue;
      if (imported.fromLibrary === null) continue;

      const provider = tables.get(imported.fromLibrary);
      // Not embedded in this app — a system dylib. Out of scope by design.
      if (provider === undefined) continue;

      checkedEdges += 1;
      if (provider.defined.has(imported.name)) continue;
      if (allowed.has(imported.name)) continue;

      const definedElsewhere: string[] = [];
      const reported = new Set<SymbolTable>();
      for (const [name, other] of tables) {
        if (name === imported.fromLibrary || reported.has(other)) continue;
        if (!other.defined.has(imported.name)) continue;
        reported.add(other);
        definedElsewhere.push(name);
      }

      breaks.push({
        client,
        symbol: imported.name,
        expectedIn: imported.fromLibrary,
        definedElsewhere,
      });
    }
  }

  return { checkedEdges, breaks };
}

/** Injectable I/O seam so the parser and the rule stay testable off macOS. */
export interface MachOInspector {
  /** Mach-O files inside the app, keyed by the name `nm` reports in `(from X)`. */
  listBinaries(appPath: string): Map<string, string>;
  /** `nm -arch arm64 -m <binaryPath>` output. */
  readSymbols(binaryPath: string): string;
}

/**
 * Every Mach-O in the bundle: the app executable (where our own Swift under
 * packages/mobile/modules lands) plus each embedded framework and dylib.
 *
 * PlugIns/*.appex (the @bacons/apple-targets widget and share extension) are
 * out of scope for now — they carry their own Frameworks/ dir and would need
 * to be walked as separate images.
 */
export function listAppBinaries(appPath: string): Map<string, string> {
  const binaries = new Map<string, string>();

  const executable = join(appPath, basename(appPath).replace(/\.app$/, ''));
  if (existsSync(executable)) binaries.set(basename(executable), executable);

  const frameworksDir = join(appPath, 'Frameworks');
  if (!existsSync(frameworksDir)) return binaries;

  for (const entry of readdirSync(frameworksDir)) {
    const entryPath = join(frameworksDir, entry);
    if (entry.endsWith('.framework')) {
      const frameworkBinary = join(entryPath, entry.replace(/\.framework$/, ''));
      if (existsSync(frameworkBinary)) binaries.set(basename(frameworkBinary), frameworkBinary);
      continue;
    }
    if (entry.endsWith('.dylib') && statSync(entryPath).isFile()) {
      binaries.set(entry, entryPath);
      // `nm` may name a dylib with or without its extension depending on the
      // recorded install name; accept both spellings.
      binaries.set(entry.replace(/\.dylib$/, ''), entryPath);
    }
  }

  return binaries;
}

export const nmInspector: MachOInspector = {
  listBinaries: listAppBinaries,
  readSymbols(binaryPath) {
    return execFileSync('nm', ['-arch', 'arm64', '-m', binaryPath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  },
};

function parseAppArg(argv: readonly string[]): string | null {
  const index = argv.indexOf('--app');
  if (index !== -1 && index + 1 < argv.length) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith('--app='));
  return inline ? inline.slice('--app='.length) : null;
}

/**
 * Wire the real toolchain and run the check. Returns the process exit code.
 *
 * `platform` is a parameter rather than a direct `process.platform` read so the
 * tests can drive everything below the skip on any host: they inject a
 * MachOInspector and never invoke `nm`, and the per-PR gate has no macOS runner,
 * so an inline read would leave the false-green guard with no coverage at all.
 */
export function main(
  argv: readonly string[] = process.argv.slice(2),
  inspector: MachOInspector = nmInspector,
  platform: string = process.platform,
): number {
  // macOS-only: there is no `nm` that reads Mach-O on the Linux PR runners, so
  // skip the way scripts/mobile-simulator-check.sh does rather than fail.
  if (platform !== 'darwin') {
    console.log('[mobile-abi] Skipped: Mach-O inspection needs macOS `nm`.');
    return 0;
  }

  const appPath = parseAppArg(argv);
  if (appPath === null) {
    console.error('[mobile-abi] FAILED — pass the built app: --app <path-to-.app>');
    return 1;
  }
  if (!existsSync(appPath)) {
    console.error(`[mobile-abi] FAILED — no app bundle at ${appPath}`);
    return 1;
  }

  let binaries: Map<string, string>;
  try {
    binaries = inspector.listBinaries(appPath);
  } catch (error) {
    console.error(`[mobile-abi] FAILED — cannot read ${appPath}: ${(error as Error).message}`);
    return 1;
  }

  // A guard that silently inspects nothing is worse than no guard.
  if (binaries.size === 0) {
    console.error(`[mobile-abi] FAILED — no Mach-O binaries found in ${appPath}.`);
    return 1;
  }

  const tables = new Map<string, SymbolTable>();
  const parsedByPath = new Map<string, SymbolTable>();
  for (const [name, path] of binaries) {
    let parsed = parsedByPath.get(path);
    if (parsed === undefined) {
      try {
        parsed = parseNmOutput(inspector.readSymbols(path));
      } catch (error) {
        console.error(`[mobile-abi] FAILED — nm could not read ${path}: ${(error as Error).message}`);
        return 1;
      }
      parsedByPath.set(path, parsed);
    }
    tables.set(name, parsed);
  }

  const { checkedEdges, breaks } = findAbiBreaks(tables);

  // An app embedding ExpoModulesCore and ExpoModulesJSI has cross-framework
  // edges by construction. Zero means the parse or the name matching broke, not
  // that the app is clean.
  if (checkedEdges === 0) {
    console.error(
      `[mobile-abi] FAILED — inspected ${parsedByPath.size} binaries but compared 0 cross-framework symbols. ` +
        'The nm output or the (from X) name matching is wrong; this run proved nothing.',
    );
    return 1;
  }

  if (breaks.length > 0) {
    console.error('[mobile-abi] FAILED — embedded frameworks disagree; this app would abort in dyld at launch:');
    for (const abiBreak of breaks) {
      console.error(`  ✗ ${abiBreak.client} needs ${abiBreak.symbol}`);
      console.error(`      expected in: ${abiBreak.expectedIn} (which does not export it)`);
      if (abiBreak.definedElsewhere.length > 0) {
        console.error(`      but defined in: ${abiBreak.definedElsewhere.join(', ')} — probably a re-export`);
      }
    }
    console.error(
      '  A prebuilt xcframework was built against a different version of a framework it links. ' +
        'Align the versions in packages/mobile/package.json (and check pnpm-lock.yaml resolved what you expect).',
    );
    return 1;
  }

  console.log(
    `[mobile-abi] OK — ${checkedEdges} cross-framework symbol(s) resolve across ${parsedByPath.size} embedded binaries.`,
  );
  return 0;
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
