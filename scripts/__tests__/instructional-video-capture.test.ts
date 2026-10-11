import { describe, expect, it } from 'vitest';
import {
  assertLocalTutorialBackend,
  measureTutorialScreen,
  trimTutorialAnchors,
  tutorialCaptureFingerprint,
  tutorialManifestProblems,
} from '../lib/instructional-video/capture';
import type { TutorialTake, TutorialTakeManifest } from '../lib/instructional-video/types';

const take: TutorialTake = {
  id: 'crew',
  chapterId: 'crew',
  route: 'climbs',
  flow: 'crew.yaml',
  setupFlows: ['setup.yaml'],
  requiredMarks: ['invite', 'contribution'],
  requiredAnchors: ['invite-qr'],
  minSeconds: 28,
};
const geometry = measureTutorialScreen(
  'Physical size: 1440x3120\nOverride size: 1080x2424',
  'Physical density: 560\nOverride density: 420',
);
const identity = { captureSourceSha256: 'mobile-source', nativeArtifactSha256: 'apk', geometry, scenario: 'seed-1' };
const flowContents: Record<string, string> = {
  'crew.yaml': 'capture real crew',
  'setup.yaml': 'prepare private session',
};
const readFlow = (path: string) => flowContents[path] ?? 'assert real prerequisite';
const fingerprint = tutorialCaptureFingerprint(take, identity, readFlow);
const manifest: TutorialTakeManifest = {
  formatVersion: 1,
  takeId: 'crew',
  platform: 'android',
  fps: 30,
  ...geometry,
  frameCount: 900,
  seconds: 30,
  sourceCommit: 'abc',
  nativeArtifactSha256: 'apk',
  fingerprint,
  marks: { invite: 0, contribution: 7 },
  anchors: { 'invite-qr': [{ t: 0, x: 30, y: 90, width: 200, height: 200 }] },
};

describe('tutorial capture safety and evidence', () => {
  it('carries the latest pre-trim anchor forward and normalizes measured dp geometry', () => {
    expect(
      trimTutorialAnchors(
        [
          { t: 0, x: 20, y: 40, width: 100, height: 200 },
          { t: 3, x: 40, y: 60, width: 80, height: 120 },
        ],
        2,
        { width: 400, height: 800 },
      ),
    ).toEqual([
      { t: 0, x: 0.05, y: 0.05, width: 0.25, height: 0.25 },
      { t: 1, x: 0.1, y: 0.075, width: 0.2, height: 0.15 },
    ]);
  });
  it('drops incidental offscreen, empty and late measurements', () => {
    expect(
      trimTutorialAnchors(
        [
          { t: 0, x: -10, y: 0, width: 30, height: 30 },
          { t: 1, x: 10, y: 10, width: 0, height: 30 },
          { t: 2, x: 10, y: 10, width: 30, height: 30 },
          { t: 4, x: 10, y: 10, width: 30, height: 30 },
        ],
        0,
        { width: 100, height: 100 },
        3,
      ),
    ).toEqual([{ t: 2, x: 0.1, y: 0.1, width: 0.3, height: 0.3 }]);
  });
  it('only permits loopback HTTP demo backends', () => {
    expect(assertLocalTutorialBackend('http://127.0.0.1:8181').port).toBe('8181');
    for (const backend of [
      'https://ws.boardsesh.com',
      'http://127.0.0.1.example.com',
      'https://localhost:8181',
      'file:///tmp/backend',
    ])
      expect(() => assertLocalTutorialBackend(backend)).toThrow();
  });
  it('uses actual override dimensions and density rather than authored Pixel points', () => {
    expect(geometry.width).toBe(1080);
    expect(geometry.screen.width).toBeCloseTo(411.42857);
    expect(geometry.screen.height).toBeCloseTo(923.42857);
    expect(() => measureTutorialScreen('no size', 'no density')).toThrow();
  });
  it('invalidates capture when flows, seed, artifact or geometry change', () => {
    expect(tutorialCaptureFingerprint(take, identity, () => 'changed flow')).not.toBe(fingerprint);
    expect(tutorialCaptureFingerprint(take, { ...identity, scenario: 'seed-2' }, readFlow)).not.toBe(fingerprint);
    expect(tutorialCaptureFingerprint(take, { ...identity, nativeArtifactSha256: 'new-apk' }, readFlow)).not.toBe(
      fingerprint,
    );
    expect(tutorialCaptureFingerprint(take, { ...identity, geometry: { ...geometry, width: 720 } }, readFlow)).not.toBe(
      fingerprint,
    );
  });
  it('rejects missing evidence and marks outside the recorded clip', () => {
    expect(tutorialManifestProblems(manifest, take, fingerprint)).toEqual([]);
    expect(
      tutorialManifestProblems({ ...manifest, marks: { invite: 0, contribution: 30 } }, take, fingerprint),
    ).toContain('missing or out-of-range mark contribution');
    expect(tutorialManifestProblems({ ...manifest, anchors: {} }, take, fingerprint)).toContain(
      'missing anchor invite-qr',
    );
    expect(tutorialManifestProblems({ ...manifest, frameCount: 300, seconds: 10 }, take, fingerprint)).toContain(
      'footage is too short',
    );
    expect(tutorialManifestProblems(manifest, take, 'different')).toContain('capture identity differs');
  });
});
