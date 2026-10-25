/// <reference types="node" />

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function requireFromPackage(parentRequire: NodeRequire, packageName: string): NodeRequire {
  return createRequire(parentRequire.resolve(`${packageName}/package.json`));
}

const webRequire = createRequire(new URL('../../packages/web/package.json', import.meta.url));
const mobileRequire = createRequire(new URL('../../packages/mobile/package.json', import.meta.url));

describe('React type isolation between web and mobile', () => {
  const materialRequire = requireFromPackage(webRequire, '@mui/material');
  const systemRequire = requireFromPackage(materialRequire, '@mui/system');
  const webDependencies = [
    { name: 'Next', packageRequire: requireFromPackage(webRequire, 'next') },
    { name: 'MUI material', packageRequire: materialRequire },
    {
      name: 'MUI Autocomplete declarations',
      packageRequire: createRequire(materialRequire.resolve('@mui/material/Autocomplete')),
    },
    {
      name: 'MUI TextField declarations',
      packageRequire: createRequire(materialRequire.resolve('@mui/material/TextField')),
    },
    {
      name: 'MUI InputBase declarations',
      packageRequire: createRequire(materialRequire.resolve('@mui/material/InputBase')),
    },
    { name: 'MUI system', packageRequire: systemRequire },
    { name: 'MUI material utilities', packageRequire: requireFromPackage(materialRequire, '@mui/utils') },
    { name: 'MUI web utilities', packageRequire: requireFromPackage(webRequire, '@mui/utils') },
    { name: 'MUI material types', packageRequire: requireFromPackage(materialRequire, '@mui/types') },
    { name: 'MUI private theming', packageRequire: requireFromPackage(systemRequire, '@mui/private-theming') },
    {
      name: 'MUI styled engine',
      packageRequire: requireFromPackage(systemRequire, '@mui/styled-engine'),
    },
    { name: 'Emotion React', packageRequire: requireFromPackage(webRequire, '@emotion/react') },
    { name: 'Emotion styled', packageRequire: requireFromPackage(webRequire, '@emotion/styled') },
    {
      name: 'React transition group declarations',
      packageRequire: requireFromPackage(materialRequire, '@types/react-transition-group'),
    },
    { name: 'web react-i18next', packageRequire: requireFromPackage(webRequire, 'react-i18next') },
  ];

  it.each(webDependencies)('$name uses the web app’s React declarations', ({ packageRequire }) => {
    expect(packageRequire.resolve('@types/react/package.json')).toBe(webRequire.resolve('@types/react/package.json'));
  });

  it('mobile react-i18next uses the mobile app’s React declarations', () => {
    const i18nextRequire = requireFromPackage(mobileRequire, 'react-i18next');
    expect(i18nextRequire.resolve('@types/react/package.json')).toBe(
      mobileRequire.resolve('@types/react/package.json'),
    );
  });

  it.each([
    { name: 'web', packageRequire: webRequire },
    { name: 'Next', packageRequire: requireFromPackage(webRequire, 'next') },
  ])('$name resolves ReactDOM declarations backed by web React', ({ packageRequire }) => {
    const reactDomTypes = packageRequire.resolve('@types/react-dom/package.json');
    expect(reactDomTypes).toBe(webRequire.resolve('@types/react-dom/package.json'));
    expect(createRequire(reactDomTypes).resolve('@types/react/package.json')).toBe(
      webRequire.resolve('@types/react/package.json'),
    );
  });

  it.each(['board-react', 'create-climb-react', 'playlists-react'])(
    '%s tests render with the package’s React version',
    (packageName) => {
      const packageRequire = createRequire(
        new URL(`../../packages/shared/${packageName}/package.json`, import.meta.url),
      );
      const testingLibraryRequire = requireFromPackage(packageRequire, '@testing-library/react');
      const version = (packagePath: string) =>
        (JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }).version;
      const expectedReact = version(packageRequire.resolve('react/package.json'));
      expect(version(testingLibraryRequire.resolve('react/package.json'))).toBe(expectedReact);
      expect(version(testingLibraryRequire.resolve('react-dom/package.json'))).toBe(expectedReact);
    },
  );
});
