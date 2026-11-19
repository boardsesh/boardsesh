import { describe, expect, it } from 'vite-plus/test';
import {
  parseSessionHistoryExportId,
  readPendingSessionHistory,
  serializePendingSessionHistory,
} from '../partner-session-history-link';

const EXPORT_ID = '3c2d56f7-1f63-4c63-9c48-3c239b14727d';

describe('partner session history links', () => {
  it.each([
    `https://www.boardsesh.com/history/session/${EXPORT_ID}`,
    `https://boardsesh.com/es/history/session/${EXPORT_ID}?from=partner`,
    `https://www.boardsesh.com/zh-CN/history/session/${EXPORT_ID}?from=partner`,
    `com.boardsesh.app://history/session/${EXPORT_ID}`,
    `/history/session/${EXPORT_ID}`,
    `/zh-CN/history/session/${EXPORT_ID}`,
  ])('accepts an opaque history reference from %s', (url) => {
    expect(parseSessionHistoryExportId(url)).toBe(EXPORT_ID);
  });

  it.each([
    `https://evil.example/history/session/${EXPORT_ID}`,
    `https://boardsesh.com.evil.example/history/session/${EXPORT_ID}`,
    `https://www.boardsesh.com/join/${EXPORT_ID}`,
    `com.boardsesh.app://session/${EXPORT_ID}`,
    '/history/session/../private',
    '/history/session/not-a-uuid',
    `/es-419/history/session/${EXPORT_ID}`,
    `/xx/history/session/${EXPORT_ID}`,
  ])('refuses unrelated URLs and invite paths: %s', (url) => {
    expect(parseSessionHistoryExportId(url)).toBeNull();
  });

  it('keeps a destination through sign-in for one day only', () => {
    const now = 10_000;
    const stored = serializePendingSessionHistory(EXPORT_ID, now);
    expect(readPendingSessionHistory(stored, now + 60_000)).toBe(EXPORT_ID);
    expect(readPendingSessionHistory(stored, now + 24 * 60 * 60 * 1000 + 1)).toBeNull();
    expect(readPendingSessionHistory(stored, now - 1)).toBeNull();
    expect(readPendingSessionHistory('not-json', now)).toBeNull();
  });
});
