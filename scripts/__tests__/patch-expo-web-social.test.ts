/// <reference types="node" />
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patchExpoWebSocial } from '../lib/patch-expo-web-social.mjs';

const SHELL =
  '<html><head><meta name="robots" content="noindex, follow"><meta name="theme-color" content="#000000"><link rel="icon" href="https://cdn.example/icon.png"><link rel="apple-touch-icon" href="https://cdn.example/apple.png"></head><body></body></html>';

describe('static Expo share metadata', () => {
  let exportDir: string;
  beforeEach(() => {
    exportDir = mkdtempSync(join(tmpdir(), 'expo-social-'));
    writeFileSync(join(exportDir, 'index.html'), SHELL);
    writeFileSync(join(exportDir, 'og.png'), 'fixture-image');
  });
  afterEach(() => rmSync(exportDir, { recursive: true, force: true }));

  it.each([
    ['', 'https://app.boardsesh.com/og.png'],
    ['/app', 'https://www.boardsesh.com/app/og.png'],
  ])('writes the correct image for base %s without changing existing shell metadata', (basePrefix, expectedUrl) => {
    expect(patchExpoWebSocial(exportDir, basePrefix)).toBe(expectedUrl);
    const shell = readFileSync(join(exportDir, 'index.html'), 'utf8');
    expect(shell).toContain(`property="og:image" content="${expectedUrl}"`);
    expect(shell).toContain(`name="twitter:image" content="${expectedUrl}"`);
    expect(shell).toContain('name="robots" content="noindex, follow"');
    expect(shell).toContain('name="theme-color" content="#000000"');
    expect(shell.match(/rel="icon"/g)).toHaveLength(1);
    expect(shell).toContain('href="https://cdn.example/icon.png"');
    expect(shell).toContain('href="https://cdn.example/apple.png"');
    patchExpoWebSocial(exportDir, basePrefix);
    expect(readFileSync(join(exportDir, 'index.html'), 'utf8')).toBe(shell);
  });

  it('replaces an older preview without leaving conflicting metadata', () => {
    writeFileSync(
      join(exportDir, 'index.html'),
      SHELL.replace('</head>', '<meta property="og:image" content="old.png"></head>'),
    );
    patchExpoWebSocial(exportDir, '');
    const shell = readFileSync(join(exportDir, 'index.html'), 'utf8');
    expect(shell).not.toContain('old.png');
    expect(shell.match(/property="og:image" /g)).toHaveLength(1);
  });

  it('refuses a missing image without altering the shell', () => {
    rmSync(join(exportDir, 'og.png'));
    expect(() => patchExpoWebSocial(exportDir, '')).toThrow('missing or empty preview image');
    expect(readFileSync(join(exportDir, 'index.html'), 'utf8')).toBe(SHELL);
  });
});
