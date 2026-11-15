import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cppStoryCaptures, readVisualStoryCaptures, storyForCaptureName } from '../lib/mobile-visual-stories';
import { CPP_TARGETS, readCppPage } from '../lib/screenshot-cpp';

const maestroRoot = resolve(import.meta.dirname, '../../packages/mobile/.maestro');
describe('visual capture inventory', () => {
  it.each(
    readdirSync(maestroRoot).filter(
      (name) => /^(app-store(?!-cpp)|help\.|onboarding)/.test(name) && name.endsWith('.yaml'),
    ),
  )('preserves each filename and assigns an isolated view: %s', (filename) => {
    const captures = readVisualStoryCaptures(resolve(maestroRoot, filename));
    expect(captures.length).toBeGreaterThan(0);
    for (const capture of captures) {
      expect(capture.name).toMatch(/^[a-z0-9-]+$/);
      expect(capture.storyId).toMatch(/^[a-z0-9-]+--[a-z0-9-]+$/);
    }
  });
  it.each(CPP_TARGETS)('uses each exact CPP board geometry for %s', (target) => {
    const page = readCppPage(target);
    for (const device of ['phone', 'ipad'] as const) {
      const captures = cppStoryCaptures(page, device);
      expect(captures.map((capture) => capture.name + '.png').sort()).toEqual(
        [...new Set(page.recipes[device].flatMap((recipe) => recipe.sources))].sort(),
      );
      for (const [index, board] of page.heroBoards.entries()) {
        expect(captures.find((capture) => capture.name === `hero-${index + 1}`)?.storyId).toBe(`player--${board.id}`);
      }
      for (const capture of captures.filter(({ name }) => !/^(hero|other)-/.test(name) && name !== '08-island')) {
        expect(capture.storyId).toBe(`cpp-scenes--${target}-${capture.name.replace(/^\d+-/, '')}`);
      }
    }
  });
  it('rejects a target whose primary board has no corresponding scene fixture', () => {
    const page = readCppPage('moonboard');
    expect(() => cppStoryCaptures({ ...page, primaryBoard: { ...page.primaryBoard, id: 'unknown' } }, 'phone')).toThrow(
      'No CPP scene fixtures',
    );
  });
  it('dispatches visual captures before the live runner and never executes inventory commands', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../mobile-screenshots.ts'), 'utf8');
    expect(source).toContain("if (options.flow !== 'smoke') return runVisualStories(options, platform)");
    const runner = source.slice(source.indexOf('function runVisualStories('), source.indexOf('function runPlatform('));
    expect(runner).toContain('readVisualStoryCaptures(');
    expect(runner).toContain('settleAfterStory(');
    expect(runner).not.toContain('renderedFlowFileForIosDevice(');
    expect(runner).not.toContain('runIosMaestroFlow(flowFile)');
    expect(runner).not.toContain('buildAndroidMaestroArgs(');
    expect(runner).not.toContain('buildScreenshotSessionEnv(');
  });
  it('never substitutes a generic board for an unknown capture', () => {
    expect(() => storyForCaptureName('00-new-board-view')).toThrow('No view story');
    expect(storyForCaptureName('00-tension-board-view')).toBe('player--tension');
    expect(storyForCaptureName('00-moonboard-2024-view')).toBe('player--moonboard-2024');
  });
});
