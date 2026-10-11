import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  assertLocalTutorialBackend,
  measureTutorialScreen,
  trimTutorialAnchors,
  tutorialCaptureFingerprint,
  tutorialManifestProblems,
} from '../lib/instructional-video/capture';
import {
  selectActiveTutorialSession,
  tutorialSessionStillActive,
  discoverTutorialSession,
  authorizeTutorialCrew,
} from '../lib/instructional-video/capture-crew';
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
  it('selects the primary active board session even when ended sessions are returned first', () => {
    expect(
      selectActiveTutorialSession(
        [
          { id: 'ended-crew', isActive: false, boardPath: 'kilter/1/7/1,20/40' },
          { id: 'other-board', isActive: true, boardPath: 'tension/1/10/1/40' },
          { id: 'current-workout', isActive: true, boardPath: 'kilter/1/7/1,20/40' },
        ],
        'kilter/1/7/1,20',
      ),
    ).toBe('current-workout');
  });
  it('rejects missing or ambiguous primary sessions instead of joining or proving the wrong queue', () => {
    expect(() => selectActiveTutorialSession([], 'kilter/1/7/1')).toThrow();
    expect(() =>
      selectActiveTutorialSession(
        [
          { id: 'first', isActive: true, boardPath: 'kilter/1/7/1/40' },
          { id: 'second', isActive: true, boardPath: 'kilter/1/7/1/45' },
        ],
        'kilter/1/7/1',
      ),
    ).toThrow();
  });
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
  it('invalidates crew capture when its real tutorial invite setup changes', () => {
    const crewTake: TutorialTake = {
      ...take,
      session: 'crew',
      flow: 'packages/mobile/.maestro/tutorial/crew.yaml',
      setupFlows: [],
    };
    const invitePath = 'packages/mobile/.maestro/tutorial/crew-invite.yaml';
    const visited = new Set<string>();
    const readActualFlow = (path: string) => {
      visited.add(path);
      return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    };
    const before = tutorialCaptureFingerprint(crewTake, identity, readActualFlow);
    expect(visited.has(invitePath)).toBe(true);
    expect(visited.has('packages/mobile/.maestro/showcase/android/crew-invite.yaml')).toBe(false);
    const after = tutorialCaptureFingerprint(crewTake, identity, (path) => {
      const content = readActualFlow(path);
      return path === invitePath ? `${content}\n- assertVisible: 'Require a different invite state'\n` : content;
    });
    expect(after).not.toBe(before);
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

describe('tutorial session teardown evidence', () => {
  it('rejects an empty owner list instead of treating an invalid token as ended', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: { mySessions: [] } })));
    try {
      await expect(
        tutorialSessionStillActive(new URL('http://127.0.0.1:8000'), 'invalid-token', 'captured'),
      ).rejects.toThrow('missing from its owner');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('uses durable status even when ended-session presence still looks active', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const body = JSON.parse(options?.body as string) as { variables?: { id: string } };
      return Response.json({
        data: body.variables
          ? { sessionStatus: body.variables.id === 'captured' ? 'ended' : 'active' }
          : {
              mySessions: [
                { id: 'captured', isActive: true, boardPath: 'kilter/1/7/1' },
                { id: 'other', isActive: true, boardPath: 'kilter/1/7/1' },
              ],
            },
      });
    });
    try {
      expect(await tutorialSessionStillActive(new URL('http://127.0.0.1:8000'), 'primary-token', 'captured')).toBe(
        false,
      );
      expect(await tutorialSessionStillActive(new URL('http://127.0.0.1:8000'), 'primary-token', 'other')).toBe(true);
      expect(await discoverTutorialSession(new URL('http://127.0.0.1:8000'), 'primary-token', 'kilter/1/7/1')).toBe(
        'other',
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it.each([null, ['ended']])('rejects malformed durable status %j instead of accepting teardown', async (status) => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ data: { mySessions: [{ id: 'captured', isActive: true, boardPath: 'kilter/1/7/1' }] } }),
      )
      .mockResolvedValueOnce(Response.json({ data: { sessionStatus: status } }));
    try {
      await expect(
        tutorialSessionStillActive(new URL('http://127.0.0.1:8000'), 'primary-token', 'captured'),
      ).rejects.toThrow('no authoritative durable status');
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it('refuses to declare teardown complete when the authoritative response is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: {} })));
    try {
      await expect(
        tutorialSessionStillActive(new URL('http://127.0.0.1:8000'), 'primary-token', 'captured'),
      ).rejects.toThrow('no session list');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('private tutorial crew access', () => {
  it('requests as Sam before approving as the owner', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: { requestResourceAccess: true } }))
      .mockResolvedValueOnce(Response.json({ data: { approveResourceAccess: true } }));
    try {
      await authorizeTutorialCrew(new URL('http://127.0.0.1:34273'), 'primary', 'crew', 'session', 'sam-user');
      expect(fetchSpy.mock.calls.map(([, options]) => options?.headers)).toEqual([
        { 'content-type': 'application/json', authorization: 'Bearer crew' },
        { 'content-type': 'application/json', authorization: 'Bearer primary' },
      ]);
      expect(JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).variables).toEqual({
        kind: 'session',
        resourceId: 'session',
        userId: 'sam-user',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it('rejects a denied request before sending approval', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ errors: [{ message: 'Not found' }] }));
    try {
      await expect(
        authorizeTutorialCrew(new URL('http://127.0.0.1:34273'), 'primary', 'crew', 'session', 'sam-user'),
      ).rejects.toThrow('could not authorize');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it('rejects a missing mutation result without authorizing the participant', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ data: {} }));
    try {
      await expect(
        authorizeTutorialCrew(new URL('http://127.0.0.1:34273'), 'primary', 'crew', 'session', 'sam-user'),
      ).rejects.toThrow('could not authorize');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
