/**
 * The screenshot trust boundary. Two things are load-bearing:
 *
 * 1. Only a key this system minted may become a URL. The comment is public, and
 *    the keys arrive from the client as opaque strings.
 * 2. Nothing throws. A bucket with no public base costs the pictures, never the
 *    verdict or the bug report.
 *
 * Env is mocked the way `storage/__tests__/s3.test.ts` does it — overlay onto a
 * copy of the real environment, then `resetStorageClients()` so the lazily
 * cached bucket config is re-read.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { FEEDBACK_SCREENSHOT_MAX_COUNT } from '@boardsesh/shared-schema';
import { resetStorageClients } from '../../storage/s3';
import {
  resetScreenshotUrlWarning,
  screenshotMarkdownSection,
  screenshotPublicUrls,
} from '../feedback-screenshot-urls';
import { logger } from '../../utils/logger';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORIGINAL_ENV = { ...process.env };

/** The public media bucket as production has it: R2 behind a CDN domain. */
const MEDIA_ENV = {
  MEDIA_S3_BUCKET_NAME: 'boardsesh-user-media',
  MEDIA_AWS_ENDPOINT_URL: 'https://acct123.r2.cloudflarestorage.com',
  MEDIA_AWS_REGION: 'auto',
  MEDIA_AWS_ACCESS_KEY_ID: 'media-key',
  MEDIA_AWS_SECRET_ACCESS_KEY: 'media-secret',
  MEDIA_PUBLIC_BASE_URL: 'https://media.boardsesh.com',
};

function setEnv(...overlays: Record<string, string>[]): void {
  process.env = Object.assign({ ...ORIGINAL_ENV }, ...overlays);
}

const key = (uuid: string, extension = 'jpg') => `feedback-screenshots/${uuid}.${extension}`;

const UUIDS = [
  '11111111-2222-4333-8444-555555555555',
  '66666666-7777-4888-8999-aaaaaaaaaaaa',
  'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  '01234567-89ab-4cde-8f01-23456789abcd',
  'fedcba98-7654-4321-8fed-cba987654321',
];

beforeEach(() => {
  setEnv(MEDIA_ENV);
  resetStorageClients();
  resetScreenshotUrlWarning();
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetStorageClients();
});

describe('screenshotPublicUrls', () => {
  it('maps minted keys onto the media bucket public base, in order', () => {
    expect(screenshotPublicUrls([key(UUIDS[0]), key(UUIDS[1], 'png')])).toEqual([
      `https://media.boardsesh.com/feedback-screenshots/${UUIDS[0]}.jpg`,
      `https://media.boardsesh.com/feedback-screenshots/${UUIDS[1]}.png`,
    ]);
  });

  it('answers an empty list for no keys at all', () => {
    expect(screenshotPublicUrls(null)).toEqual([]);
    expect(screenshotPublicUrls(undefined)).toEqual([]);
    expect(screenshotPublicUrls([])).toEqual([]);
  });

  it('drops a key this system could not have minted', () => {
    // Right prefix, wrong everything else: a forged id, a disallowed extension,
    // a bare filename, and an absolute URL someone hoped we would echo back.
    expect(
      screenshotPublicUrls([
        'feedback-screenshots/not-a-uuid.jpg',
        key(UUIDS[0], 'svg'),
        'avatars/11111111-2222-4333-8444-555555555555.jpg',
        `${UUIDS[0]}.jpg`,
        'https://evil.example.com/pwn.jpg',
        '',
      ]),
    ).toEqual([]);
  });

  it('drops a key that tries to climb out of the prefix', () => {
    expect(
      screenshotPublicUrls([
        `feedback-screenshots/../../etc/passwd`,
        `feedback-screenshots/../avatars/${UUIDS[0]}.jpg`,
        `feedback-screenshots/${UUIDS[0]}.jpg/../../secret.jpg`,
      ]),
    ).toEqual([]);
  });

  it('keeps the minted keys out of a list that also carries forged ones', () => {
    expect(screenshotPublicUrls(['feedback-screenshots/nope.jpg', key(UUIDS[0])])).toEqual([
      `https://media.boardsesh.com/feedback-screenshots/${UUIDS[0]}.jpg`,
    ]);
  });

  it('truncates a list longer than the cap', () => {
    expect(UUIDS.length).toBeGreaterThan(FEEDBACK_SCREENSHOT_MAX_COUNT);

    const urls = screenshotPublicUrls(UUIDS.map((uuid) => key(uuid)));

    expect(urls).toHaveLength(FEEDBACK_SCREENSHOT_MAX_COUNT);
    expect(urls[FEEDBACK_SCREENSHOT_MAX_COUNT - 1]).toBe(
      `https://media.boardsesh.com/feedback-screenshots/${UUIDS[FEEDBACK_SCREENSHOT_MAX_COUNT - 1]}.jpg`,
    );
  });

  it('degrades to no screenshots when the media bucket has no public base URL', () => {
    // R2's S3 endpoint always 401s for an anonymous reader, so `getPublicUrl`
    // throws rather than mint a link that never loads. Losing the verdict over
    // that would be much worse than a comment with no pictures in it.
    const { MEDIA_PUBLIC_BASE_URL: _unset, ...withoutPublicBase } = MEDIA_ENV;
    setEnv(withoutPublicBase);
    resetStorageClients();

    expect(screenshotPublicUrls([key(UUIDS[0])])).toEqual([]);
  });

  it('warns once, not once per submission, about the missing public base', () => {
    const { MEDIA_PUBLIC_BASE_URL: _unset, ...withoutPublicBase } = MEDIA_ENV;
    setEnv(withoutPublicBase);
    resetStorageClients();

    screenshotPublicUrls([key(UUIDS[0])]);
    screenshotPublicUrls([key(UUIDS[1])]);

    const screenshotWarnings = vi
      .mocked(logger.warn)
      .mock.calls.filter(([message]) => String(message).includes('[feedback-screenshots]'));
    expect(screenshotWarnings).toHaveLength(1);
  });
});

describe('screenshotMarkdownSection', () => {
  it('renders nothing for a submission with no screenshots', () => {
    expect(screenshotMarkdownSection([])).toEqual([]);
  });

  it('renders one width-capped img tag per URL under a heading', () => {
    expect(
      screenshotMarkdownSection([
        'https://media.boardsesh.com/feedback-screenshots/a.jpg',
        'https://media.boardsesh.com/feedback-screenshots/b.png',
      ]),
    ).toEqual([
      '',
      '## Screenshots',
      '',
      '<img src="https://media.boardsesh.com/feedback-screenshots/a.jpg" width="300">',
      '<img src="https://media.boardsesh.com/feedback-screenshots/b.png" width="300">',
    ]);
  });

  it('caps the width rather than letting a full-height phone screenshot through', () => {
    // A raw `![](…)` renders at the image's own size, and a 2796px-tall
    // screenshot then owns the whole PR timeline.
    const [, , , tag] = screenshotMarkdownSection(['https://media.boardsesh.com/feedback-screenshots/a.jpg']);
    expect(tag).toContain('width="300"');
    expect(tag).not.toContain('![');
  });
});
