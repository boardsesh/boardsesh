import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shellSource = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

describe('Expo web HTML appearance shell', () => {
  it('paints dark before React mounts', () => {
    expect(shellSource).toMatch(
      /html,\s*body\s*\{[\s\S]*?background-color:\s*#000000;[\s\S]*?color-scheme:\s*dark;[\s\S]*?\}/,
    );
    expect(shellSource).toMatch(/#root\s*\{[\s\S]*?background-color:\s*#000000;[\s\S]*?\}/);
  });
});
