/// <reference types="node" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findAbiBreaks,
  listAppBinaries,
  main,
  parseNmOutput,
  type MachOInspector,
  type SymbolTable,
} from '../mobile-framework-abi-check';

// The symbol that aborted TestFlight 2.4.0 (2) in dyld:
// ExpoModulesCore's prebuilt xcframework was compiled against expo-modules-jsi
// 57.0.4, which exported JavaScriptActor.assumeIsolated; jsi 57.0.6 made it
// @_alwaysEmitIntoClient and the symbol left the binary.
const ASSUME_ISOLATED = '_$s14ExpoModulesJSI15JavaScriptActorC14assumeIsolatedyxxyYbKACYcXEKRi_zlFZ';

function table(defined: string[], imports: SymbolTable['imports']): SymbolTable {
  return { defined: new Set(defined), imports };
}

function importOf(name: string, fromLibrary: string | null, weak = false) {
  return { name, fromLibrary, weak };
}

describe('parseNmOutput', () => {
  it('separates exports from undefined imports and records the source library', () => {
    const output = [
      '0000000000004a10 (__TEXT,__text) external _$s14ExpoModulesJSI15JavaScriptActorC6sharedACvgZ',
      '0000000000005b20 (__TEXT,__text) weak external _OBJC_CLASS_$_EXJavaScriptRuntime',
      '0000000000001234 (__DATA,__const) non-external _internalOnly',
      '0000000000001240 (__TEXT,__text) private external _hiddenHelper',
      `                 (undefined) external ${ASSUME_ISOLATED} (from ExpoModulesJSI)`,
      '                 (undefined) weak external _OBJC_CLASS_$_UIWindowScene (from UIKit)',
      '                 (undefined) external _swift_retain (from dynamic lookup)',
      '',
    ].join('\n');

    const parsed = parseNmOutput(output);

    expect([...parsed.defined].sort()).toEqual([
      '_$s14ExpoModulesJSI15JavaScriptActorC6sharedACvgZ',
      '_OBJC_CLASS_$_EXJavaScriptRuntime',
    ]);
    expect(parsed.imports).toEqual([
      importOf(ASSUME_ISOLATED, 'ExpoModulesJSI'),
      importOf('_OBJC_CLASS_$_UIWindowScene', 'UIKit', true),
      // "dynamic lookup" names no library, so there is nothing to assert.
      importOf('_swift_retain', null),
    ]);
  });

  it('ignores the architecture header nm prints for a fat binary', () => {
    const parsed = parseNmOutput('/path/to/Boardsesh (for architecture arm64):\n');
    expect(parsed.defined.size).toBe(0);
    expect(parsed.imports).toEqual([]);
  });
});

describe('findAbiBreaks', () => {
  it('flags the assumeIsolated regression', () => {
    const tables = new Map([
      ['ExpoModulesCore', table([], [importOf(ASSUME_ISOLATED, 'ExpoModulesJSI')])],
      ['ExpoModulesJSI', table(['_$s14ExpoModulesJSI15JavaScriptActorC6sharedACvgZ'], [])],
    ]);

    const { checkedEdges, breaks } = findAbiBreaks(tables);

    expect(checkedEdges).toBe(1);
    expect(breaks).toEqual([
      { client: 'ExpoModulesCore', symbol: ASSUME_ISOLATED, expectedIn: 'ExpoModulesJSI', definedElsewhere: [] },
    ]);
  });

  it('passes once the framework exports the symbol again', () => {
    const tables = new Map([
      ['ExpoModulesCore', table([], [importOf(ASSUME_ISOLATED, 'ExpoModulesJSI')])],
      ['ExpoModulesJSI', table([ASSUME_ISOLATED], [])],
    ]);

    const { checkedEdges, breaks } = findAbiBreaks(tables);

    expect(checkedEdges).toBe(1);
    expect(breaks).toEqual([]);
  });

  it('ignores weak imports, which dyld resolves to NULL by design', () => {
    const tables = new Map([
      ['ExpoModulesCore', table([], [importOf('_optionalThing', 'ExpoModulesJSI', true)])],
      ['ExpoModulesJSI', table([], [])],
    ]);

    expect(findAbiBreaks(tables).breaks).toEqual([]);
  });

  it('ignores dynamic-lookup imports, which name no library', () => {
    const tables = new Map([['ExpoModulesCore', table([], [importOf('_swift_retain', null)])]]);

    const { checkedEdges, breaks } = findAbiBreaks(tables);

    expect(checkedEdges).toBe(0);
    expect(breaks).toEqual([]);
  });

  it('ignores symbols bound to libraries that are not embedded in the app', () => {
    const tables = new Map([['ExpoModulesCore', table([], [importOf('_OBJC_CLASS_$_NSString', 'Foundation')])]]);

    const { checkedEdges, breaks } = findAbiBreaks(tables);

    expect(checkedEdges).toBe(0);
    expect(breaks).toEqual([]);
  });

  it('still fails a probable re-export, but names where the symbol actually lives', () => {
    const tables = new Map([
      ['ExpoModulesCore', table([], [importOf('_reexported', 'ExpoModulesJSI')])],
      ['ExpoModulesJSI', table([], [])],
      ['ReactNativeDependencies', table(['_reexported'], [])],
    ]);

    expect(findAbiBreaks(tables).breaks).toEqual([
      {
        client: 'ExpoModulesCore',
        symbol: '_reexported',
        expectedIn: 'ExpoModulesJSI',
        definedElsewhere: ['ReactNativeDependencies'],
      },
    ]);
  });

  it('suppresses an allowlisted symbol', () => {
    const tables = new Map([
      ['ExpoModulesCore', table([], [importOf('_reexported', 'ExpoModulesJSI')])],
      ['ExpoModulesJSI', table([], [])],
    ]);

    const { checkedEdges, breaks } = findAbiBreaks(tables, ['_reexported']);

    expect(checkedEdges).toBe(1);
    expect(breaks).toEqual([]);
  });
});

describe('main', () => {
  // These inject a MachOInspector and never invoke `nm`, so they run everywhere.
  // That matters: the per-PR gate has no macOS runner, and the guard that stops
  // a silent false green is the last thing that should go unexercised.
  function inspectorFor(binaries: Map<string, string>, symbols: Record<string, string>): MachOInspector {
    return {
      listBinaries: () => binaries,
      readSymbols: (path) => symbols[path] ?? '',
    };
  }

  const skewedInspector = () =>
    inspectorFor(
      new Map([
        ['ExpoModulesCore', '/app/Frameworks/ExpoModulesCore.framework/ExpoModulesCore'],
        ['ExpoModulesJSI', '/app/Frameworks/ExpoModulesJSI.framework/ExpoModulesJSI'],
      ]),
      {
        '/app/Frameworks/ExpoModulesCore.framework/ExpoModulesCore': `                 (undefined) external ${ASSUME_ISOLATED} (from ExpoModulesJSI)\n`,
        '/app/Frameworks/ExpoModulesJSI.framework/ExpoModulesJSI':
          '0000000000004a10 (__TEXT,__text) external _$s14ExpoModulesJSI15JavaScriptActorC6sharedACvgZ\n',
      },
    );

  it('fails when no Mach-O binaries are found', () => {
    expect(main(['--app', process.cwd()], inspectorFor(new Map(), {}), 'darwin')).toBe(1);
  });

  it('fails when it compared nothing, rather than reporting a false green', () => {
    // One binary whose only import is a system library: nothing to compare.
    const inspector = inspectorFor(new Map([['Boardsesh', '/app/Boardsesh']]), {
      '/app/Boardsesh': '                 (undefined) external _NSLog (from Foundation)\n',
    });

    expect(main(['--app', process.cwd()], inspector, 'darwin')).toBe(1);
  });

  it('fails on the assumeIsolated skew', () => {
    expect(main(['--app', process.cwd()], skewedInspector(), 'darwin')).toBe(1);
  });

  it('passes when the pair agrees', () => {
    const inspector = inspectorFor(
      new Map([
        ['ExpoModulesCore', '/app/Frameworks/ExpoModulesCore.framework/ExpoModulesCore'],
        ['ExpoModulesJSI', '/app/Frameworks/ExpoModulesJSI.framework/ExpoModulesJSI'],
      ]),
      {
        '/app/Frameworks/ExpoModulesCore.framework/ExpoModulesCore': `                 (undefined) external ${ASSUME_ISOLATED} (from ExpoModulesJSI)\n`,
        '/app/Frameworks/ExpoModulesJSI.framework/ExpoModulesJSI': `0000000000004a10 (__TEXT,__text) external ${ASSUME_ISOLATED}\n`,
      },
    );

    expect(main(['--app', process.cwd()], inspector, 'darwin')).toBe(0);
  });

  it('requires the --app argument', () => {
    expect(main([], inspectorFor(new Map(), {}), 'darwin')).toBe(1);
  });

  it('accepts the --app=<path> form as well as --app <path>', () => {
    expect(main([`--app=${process.cwd()}`], skewedInspector(), 'darwin')).toBe(1);
  });

  it('fails when --app points at something that does not exist', () => {
    expect(main(['--app', '/nonexistent/Boardsesh.app'], skewedInspector(), 'darwin')).toBe(1);
  });

  it('skips off macOS instead of failing the Linux PR runner', () => {
    expect(main([], inspectorFor(new Map(), {}), 'linux')).toBe(0);
  });
});

describe('listAppBinaries', () => {
  it('returns nothing for a path that is not an app bundle', () => {
    expect(listAppBinaries('/nonexistent/Boardsesh.app').size).toBe(0);
  });

  // The bundle walk is plain directory traversal, so a synthetic tree exercises
  // it anywhere — the macOS-only part is `nm`, which this never reaches.
  it('collects the app executable and every embedded framework, keyed as nm names them', () => {
    const root = mkdtempSync(join(tmpdir(), 'abi-check-'));
    const app = join(root, 'Boardsesh.app');
    try {
      mkdirSync(join(app, 'Frameworks', 'ExpoModulesCore.framework'), { recursive: true });
      mkdirSync(join(app, 'Frameworks', 'ExpoModulesJSI.framework'), { recursive: true });
      mkdirSync(join(app, 'PlugIns', 'Widgets.appex'), { recursive: true });
      writeFileSync(join(app, 'Boardsesh'), '');
      writeFileSync(join(app, 'Frameworks', 'ExpoModulesCore.framework', 'ExpoModulesCore'), '');
      writeFileSync(join(app, 'Frameworks', 'ExpoModulesJSI.framework', 'ExpoModulesJSI'), '');
      writeFileSync(join(app, 'Frameworks', 'libswiftCore.dylib'), '');
      // A framework directory with no binary inside must not be registered.
      mkdirSync(join(app, 'Frameworks', 'Empty.framework'), { recursive: true });
      writeFileSync(join(app, 'PlugIns', 'Widgets.appex', 'Widgets'), '');

      const binaries = listAppBinaries(app);

      expect(binaries.get('Boardsesh')).toBe(join(app, 'Boardsesh'));
      expect(binaries.get('ExpoModulesCore')).toBe(
        join(app, 'Frameworks', 'ExpoModulesCore.framework', 'ExpoModulesCore'),
      );
      expect(binaries.get('ExpoModulesJSI')).toBe(
        join(app, 'Frameworks', 'ExpoModulesJSI.framework', 'ExpoModulesJSI'),
      );
      expect(binaries.has('Empty')).toBe(false);
      // A dylib is registered under both spellings nm might print.
      expect(binaries.get('libswiftCore.dylib')).toBe(join(app, 'Frameworks', 'libswiftCore.dylib'));
      expect(binaries.get('libswiftCore')).toBe(join(app, 'Frameworks', 'libswiftCore.dylib'));
      // PlugIns/*.appex are their own images and are out of scope for now.
      expect(binaries.has('Widgets')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
