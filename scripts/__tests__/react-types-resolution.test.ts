/// <reference types="node" />

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

function requireFromPackage(parentRequire: NodeRequire, packageName: string): NodeRequire {
  return createRequire(parentRequire.resolve(`${packageName}/package.json`));
}

const webRequire = createRequire(new URL('../../packages/web/package.json', import.meta.url));
const mobileRequire = createRequire(new URL('../../packages/mobile/package.json', import.meta.url));

describe('React type isolation between web and mobile', () => {
  const webDependencies = [
    { name: 'Next', packageRequire: requireFromPackage(webRequire, 'next') },
    {
      name: 'MUI styled engine',
      packageRequire: requireFromPackage(requireFromPackage(webRequire, '@mui/material'), '@mui/styled-engine'),
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
});
