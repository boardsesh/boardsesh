// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compileFunction } from 'node:vm';
import * as React from 'react';
import * as compilerRuntime from 'react/compiler-runtime';
import * as jsxRuntime from 'react/jsx-runtime';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardConfig } from '../../../providers/drawer-host-provider';
import * as boardDetails from '../../../lib/board-details';
import * as renderBoardResolver from '../../../lib/boards/climb-render-board';
import * as sprayWallToken from '../../../lib/spray/use-spray-wall-token';
import { clearSprayWallRegistry, registerSprayWall, unregisterSprayWall } from '../../../lib/spray/spray-wall-registry';

type ImageProps = {
  boardName: string;
  layoutId: number;
  boardWidth: number;
  boardHeight: number;
};

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve('@expo/cli/package.json'));
const babel = expoRequire('@babel/core') as {
  transformSync: (source: string, options: Record<string, unknown>) => { code?: string | null } | null;
};

// Ordinary Vitest imports do not run Expo's React Compiler. Execute the same
// compilation here so a dependency-only registry token cannot silently vanish.
function compileThumbnail() {
  const componentFilename = '../AccessoryClimbThumbnail.tsx';
  const filename = new URL(componentFilename, import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const compiled = babel.transformSync(source, {
    filename: filename.pathname,
    configFile: false,
    babelrc: false,
    plugins: [
      [require('babel-plugin-react-compiler'), { target: '19' }],
      [expoRequire('@babel/plugin-transform-typescript'), { isTSX: true }],
      [expoRequire('@babel/plugin-transform-react-jsx'), { runtime: 'automatic' }],
      expoRequire('@babel/plugin-transform-modules-commonjs'),
    ],
  });
  if (!compiled?.code) throw new Error('Compiler produced no thumbnail code');
  const imports: Record<string, unknown> = {
    react: React,
    'react/compiler-runtime': compilerRuntime,
    'react/jsx-runtime': jsxRuntime,
    'react-native': {
      View: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
      StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    },
    '../../lib/board-details': boardDetails,
    '../../lib/boards/climb-render-board': renderBoardResolver,
    '../../lib/spray/use-spray-wall-token': sprayWallToken,
    '../BoardImageNative': {
      BoardImageNative: (props: ImageProps) =>
        React.createElement('div', {
          'data-testid': 'board-image',
          'data-board': props.boardName,
          'data-layout': props.layoutId,
          'data-width': props.boardWidth,
          'data-height': props.boardHeight,
        }),
    },
  };
  const compiledModule = { exports: {} as Record<string, unknown> };
  compileFunction(compiled.code, ['require', 'module', 'exports'])(
    (specifier: string) => {
      if (!(specifier in imports)) throw new Error(`Unexpected compiled import: ${specifier}`);
      return imports[specifier];
    },
    compiledModule,
    compiledModule.exports,
  );
  return compiledModule.exports as {
    AccessoryClimbThumbnail: typeof import('../AccessoryClimbThumbnail').AccessoryClimbThumbnail;
  };
}

const { AccessoryClimbThumbnail } = compileThumbnail();
const sprayBoard: BoardConfig = { boardName: 'spray', layoutId: 89, sizeId: 89, setIds: '1', angle: 15 };
const emptyClimb = { boardType: 'spray', layoutId: 89, angle: 15, frames: '', compatibleSizeIds: null };

function registerPhoto(versionId: number, photoWidth = 1536, photoHeight = 2048) {
  registerSprayWall(sprayBoard.layoutId, {
    wallUuid: 'reported-public-spray-wall',
    angle: 15,
    version: versionId,
    versionId,
    photoWidth,
    photoHeight,
    photoUrl: `file:///spray-version-${versionId}.jpg`,
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01T00:00:00.000Z',
    holds: [],
  });
}

beforeEach(() => {
  clearSprayWallRegistry();
  boardDetails.clearBoardRenderDataCache();
});

afterEach(() => {
  cleanup();
  clearSprayWallRegistry();
  boardDetails.clearBoardRenderDataCache();
});

describe('production-compiled accessory thumbnail (#6943)', () => {
  it('shows a spray wall arriving after mount without changing its props', () => {
    const view = render(React.createElement(AccessoryClimbThumbnail, { climb: emptyClimb, boardConfig: sprayBoard }));
    expect(view.queryByTestId('board-image')).toBeNull();

    act(() => registerPhoto(1));

    const image = view.getByTestId('board-image');
    expect(image.getAttribute('data-layout')).toBe('89');
    expect(image.getAttribute('data-width')).toBe('1536');
    expect(image.getAttribute('data-height')).toBe('2048');
  });

  it('updates dimensions when a registered wall changes version', () => {
    registerPhoto(1);
    const view = render(React.createElement(AccessoryClimbThumbnail, { climb: emptyClimb, boardConfig: sprayBoard }));
    expect(view.getByTestId('board-image').getAttribute('data-width')).toBe('1536');

    act(() => registerPhoto(2, 2048, 1536));

    expect(view.getByTestId('board-image').getAttribute('data-width')).toBe('2048');
    expect(view.getByTestId('board-image').getAttribute('data-height')).toBe('1536');
  });

  it('removes a withdrawn wall without changing its props', () => {
    registerPhoto(1);
    const view = render(React.createElement(AccessoryClimbThumbnail, { climb: emptyClimb, boardConfig: sprayBoard }));
    expect(view.queryByTestId('board-image')).not.toBeNull();

    act(() => unregisterSprayWall(sprayBoard.layoutId));

    expect(view.queryByTestId('board-image')).toBeNull();
  });

  it('keeps catalogue-board thumbnails available without a spray registry entry', () => {
    const boardConfig: BoardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
    const view = render(React.createElement(AccessoryClimbThumbnail, { climb: { frames: '' }, boardConfig }));

    expect(view.getByTestId('board-image').getAttribute('data-board')).toBe('kilter');
  });
});
