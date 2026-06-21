import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildIssueDraft,
  chunkText,
  createAppStoreConnectJwt,
  redactSensitiveText,
  syncTestFlightFeedback,
  testFlightMarker,
  type FeedbackSource,
  type IssueDraft,
  type IssueSink,
  type TestFlightCrashFeedback,
  type TestFlightScreenshotFeedback,
} from '../testflight-feedback-to-issues';

function screenshotFeedback(overrides: Partial<TestFlightScreenshotFeedback> = {}): TestFlightScreenshotFeedback {
  return {
    appPlatform: 'IOS',
    appUptimeInMilliseconds: 123_000,
    architecture: 'arm64',
    batteryPercentage: 87,
    build: { id: 'build-1', uploadedDate: '2026-06-10T10:00:00Z', version: '42' },
    buildBundleId: 'com.boardsesh.app',
    comment: 'Queue button disappears after I add a climb.',
    connectionType: 'WIFI',
    createdDate: '2026-06-11T00:00:00Z',
    deviceFamily: 'IPHONE',
    deviceModel: 'iPhone 15',
    devicePlatform: 'IOS',
    diskBytesAvailable: 1_073_741_824,
    diskBytesTotal: 128_849_018_880,
    id: 'screenshot-1',
    kind: 'screenshot',
    locale: 'en-US',
    osVersion: '18.5',
    pairedAppleWatch: 'none',
    screenHeightInPoints: 852,
    screenWidthInPoints: 393,
    screenshots: [
      {
        expirationDate: '2026-06-12T00:00:00Z',
        height: 2556,
        url: 'https://apple.example/screenshot.png',
        width: 1179,
      },
    ],
    timeZone: 'Australia/Sydney',
    ...overrides,
  };
}

function crashFeedback(overrides: Partial<TestFlightCrashFeedback> = {}): TestFlightCrashFeedback {
  return {
    ...screenshotFeedback(),
    comment: 'It crashes when I open party mode.',
    crashLog: 'Thread 0 Crashed:\n0 Boardsesh 0x0000000100000000 main + 42',
    id: 'crash-1',
    kind: 'crash',
    ...overrides,
  };
}

describe('createAppStoreConnectJwt', () => {
  it('creates an ES256 JWT signed by the supplied private key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

    const token = createAppStoreConnectJwt({
      issuerId: 'issuer-id',
      keyId: 'key-id',
      nowSeconds: 1_800_000_000,
      privateKey: privateKeyPem,
    });

    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
    expect(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'))).toEqual({
      alg: 'ES256',
      kid: 'key-id',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))).toMatchObject({
      aud: 'appstoreconnect-v1',
      exp: 1_800_001_200,
      iat: 1_800_000_000,
      iss: 'issuer-id',
    });

    const verifier = createVerify('sha256');
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    expect(
      verifier.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(encodedSignature, 'base64url')),
    ).toBe(true);
  });
});

describe('redactSensitiveText', () => {
  it('removes emails, labelled names, self-introductions, and local usernames', () => {
    const redacted = redactSensitiveText(
      'name: Marco\ntester=Jane\nMy name is Alex Smith\n/Users/marco/Library\nmarco@example.com',
    );

    expect(redacted).not.toContain('Marco');
    expect(redacted).not.toContain('Jane');
    expect(redacted).not.toContain('Alex Smith');
    expect(redacted).not.toContain('marco@example.com');
    expect(redacted).toContain('[redacted email]');
    expect(redacted).toContain('/Users/[redacted]/Library');
  });
});

describe('buildIssueDraft', () => {
  it('builds a screenshot issue with the marker, comment, metadata, and screenshot link', () => {
    const draft = buildIssueDraft(
      screenshotFeedback({ comment: 'email: tester@example.com\nScreenshot is attached.' }),
    );

    expect(draft.marker).toBe(testFlightMarker('screenshot', 'screenshot-1'));
    expect(draft.title).toBe('Screenshot feedback: email: [redacted] Screenshot is attached.');
    expect(draft.labels).toEqual(['testflight', 'ios', 'feedback', 'screenshot']);
    expect(draft.body).toContain('<!-- testflight-feedback:screenshot:screenshot-1 -->');
    expect(draft.body).toContain('email: [redacted]');
    expect(draft.body).not.toContain('tester@example.com');
    expect(draft.body).toContain('https://apple.example/screenshot.png');
    expect(draft.body).toContain('| Device model | iPhone 15 |');
    expect(draft.comments).toEqual([]);
  });

  it('splits long crash logs into follow-up comments', () => {
    const draft = buildIssueDraft(crashFeedback({ crashLog: `name: Marco\n${'crash line\n'.repeat(7000)}` }));

    expect(draft.title).toBe('Crash feedback: It crashes when I open party mode.');
    expect(draft.labels).toEqual(['testflight', 'ios', 'feedback', 'crash']);
    expect(draft.body).toContain('Crash log is split across');
    expect(draft.body).not.toContain('Marco');
    expect(draft.comments.length).toBeGreaterThan(1);
    expect(draft.comments.join('\n')).toContain('name: [redacted]');
  });
});

describe('chunkText', () => {
  it('chunks text without dropping characters', () => {
    expect(chunkText('abcdef', 2)).toEqual(['ab', 'cd', 'ef']);
  });
});

describe('syncTestFlightFeedback', () => {
  it('creates one issue per new feedback item and skips existing markers', async () => {
    const resolveAppId = vi.fn(async () => 'app-1');
    const feedbackSource: FeedbackSource = {
      resolveAppId,
      listCrashFeedback: vi.fn(async () => [crashFeedback()]),
      listScreenshotFeedback: vi.fn(async () => [screenshotFeedback()]),
    };
    const createdIssues: IssueDraft[] = [];
    const comments: string[] = [];
    const issueSink: IssueSink = {
      addIssueComment: vi.fn(async (_issueNumber, body) => {
        comments.push(body);
      }),
      createIssue: vi.fn(async (issue) => {
        createdIssues.push(issue);
        return createdIssues.length;
      }),
      ensureLabels: vi.fn(async () => undefined),
      issueExists: vi.fn(async (marker) => marker.includes('screenshot')),
    };

    const result = await syncTestFlightFeedback(
      {
        bundleId: 'com.boardsesh.app',
        dryRun: false,
        maxPages: 1,
        pageLimit: 100,
        since: new Date('2026-06-10T00:00:00Z'),
      },
      { feedbackSource, issueSink, logger: console },
    );

    expect(result).toEqual({ created: 1, dryRun: 0, skippedExisting: 1 });
    expect(createdIssues).toHaveLength(1);
    expect(createdIssues[0].marker).toBe(testFlightMarker('crash', 'crash-1'));
    expect(comments).toEqual([]);
    expect(resolveAppId).toHaveBeenCalledWith('com.boardsesh.app');
  });

  it('does not call the issue sink in dry run mode', async () => {
    const feedbackSource: FeedbackSource = {
      resolveAppId: vi.fn(async () => 'app-1'),
      listCrashFeedback: vi.fn(async () => []),
      listScreenshotFeedback: vi.fn(async () => [screenshotFeedback()]),
    };
    const createIssue = vi.fn(async () => 1);
    const issueExists = vi.fn(async () => false);
    const issueSink: IssueSink = {
      addIssueComment: vi.fn(async () => undefined),
      createIssue,
      ensureLabels: vi.fn(async () => undefined),
      issueExists,
    };

    const result = await syncTestFlightFeedback(
      {
        bundleId: 'com.boardsesh.app',
        dryRun: true,
        maxPages: 1,
        pageLimit: 100,
        since: new Date('2026-06-10T00:00:00Z'),
      },
      { feedbackSource, issueSink, logger: console },
    );

    expect(result).toEqual({ created: 0, dryRun: 1, skippedExisting: 0 });
    expect(issueExists).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
  });
});
