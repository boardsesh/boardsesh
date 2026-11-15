import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { integrationVideoLink, integrationVideoWaitSteps } from '../lib/showcase-video/integration';
import { SHOWCASE_TAKES } from '../lib/showcase-video/takes';
describe('video setup stays at the dev integration boundary', () => {
  it('translates every historical prime recipe without passing screenshot params into live screens', () => {
    for (const take of SHOWCASE_TAKES)
      for (const link of take.primeLinks) {
        const translated = integrationVideoLink(link, 'request-one');
        expect(translated).not.toMatch(/[?&]screenshot/);
        if (link.includes('screenshot')) expect(translated).toContain('dev/integration/video?');
      }
  });
  it('preserves exact board slot and first-climb intent', () => {
    expect(integrationVideoLink('climbs?screenshotOpenFirst=1&screenshotBoardIndex=6', 'request-one')).toBe(
      'dev/integration/video?command=request-one&boardIndex=6&openFirst=1',
    );
  });
  it('rejects unsupported setup instead of silently dropping an action', () => {
    expect(() => integrationVideoLink('climbs?screenshotDrive=1', 'request-one')).toThrow('Unsupported');
  });
  it('requires the matching command readiness before the next link', () => {
    const steps = integrationVideoWaitSteps('request-one').join('\n');
    expect(steps).toContain('/signal/integration-ready-request-one');
    expect(steps).toContain('times: 60');
    expect(steps).toContain('assertTrue');
  });
  it('uses content pings rather than deleted renderer logs in the navigation smoke', () => {
    const source = readFileSync(new URL('../mobile-screenshots.ts', import.meta.url), 'utf8');
    const judge = source.slice(
      source.indexOf('function judgeSmokeAttempt('),
      source.indexOf('\nfunction ', source.indexOf('function judgeSmokeAttempt(') + 10),
    );
    expect(judge).toContain('findSmokePingProblems');
    expect(judge).not.toContain('findScreenshotRenderProblems');
    expect(judge).toContain('nativeCrashes');
    expect(judge).toContain('logStreamAlive');
  });
});
