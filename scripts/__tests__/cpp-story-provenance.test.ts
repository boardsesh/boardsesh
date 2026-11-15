import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCppStoryCapture, createCppStoryCapture } from '../lib/cpp-story-provenance';
import { CPP_TARGETS, readCppPage } from '../lib/screenshot-cpp';
import { cppStoryCaptures } from '../lib/mobile-visual-stories';
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function setup(target: (typeof CPP_TARGETS)[number], device = 'iphone-16-pro-max') {
  const root = mkdtempSync(join(tmpdir(), 'cpp-story-'));
  roots.push(root);
  for (const capture of cppStoryCaptures(readCppPage(target), device.startsWith('ipad-') ? 'ipad' : 'phone'))
    writeFileSync(join(root, capture.name + '.png'), capture.storyId);
  const expected = { target, locale: 'en-US', device, sourceSha256: 'a'.repeat(64) };
  return {
    root,
    expected,
    capture: createCppStoryCapture({ ...expected, theme: 'dark', variant: 'liquidGlass', renderMode: 'classic' }, root),
  };
}
describe('explicit CPP story provenance', () => {
  it.each(CPP_TARGETS)('accepts complete %s scene pixels for phone and iPad', (target) => {
    for (const device of ['iphone-16-pro-max', 'ipad-pro-13-inch-m5']) {
      const { root, expected, capture } = setup(target, device);
      expect(() => assertCppStoryCapture(capture, expected, root)).not.toThrow();
      expect(capture).not.toHaveProperty('fixtureSha256');
      expect(capture).not.toHaveProperty('verified');
    }
  });
  it.each(['source', 'locale', 'device', 'target', 'scene', 'pixels', 'missing', 'recorded'])(
    'rejects changed %s evidence',
    (change) => {
      const { root, expected, capture } = setup('moonboard');
      if (change === 'source') capture.sourceSha256 = 'b'.repeat(64);
      if (change === 'locale') capture.locale = 'fr';
      if (change === 'device') capture.device = 'ipad-pro-13-inch-m5';
      if (change === 'target') capture.target = 'kilter';
      if (change === 'scene') capture.captures[0].storyId = 'player--kilter';
      if (change === 'pixels') writeFileSync(join(root, capture.captures[0].name + '.png'), 'changed');
      if (change === 'missing') rmSync(join(root, capture.captures[0].name + '.png'));
      if (change === 'recorded') Object.assign(capture, { fixtureSha256: 'a'.repeat(64), verified: true });
      expect(() => assertCppStoryCapture(capture, expected, root)).toThrow();
    },
  );
});
