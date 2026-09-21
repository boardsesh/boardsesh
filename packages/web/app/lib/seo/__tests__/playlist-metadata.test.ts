// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    locale: 'en-US',
  })),
}));

const mockGetPlaylistOgSummary = vi.fn();
vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getPlaylistOgSummary: (...args: unknown[]) => mockGetPlaylistOgSummary(...args),
}));

import { generatePlaylistMetadata } from '../playlist-metadata';

const baseSummary = {
  name: 'Crimpy warm-ups',
  description: null as string | null,
  color: '#FF6600',
  icon: null,
  isPublic: true,
  boardType: 'kilter',
  climbCount: 12,
  version: 'v1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPlaylistOgSummary.mockResolvedValue({ ...baseSummary });
});

describe('generatePlaylistMetadata description', () => {
  it('falls back to the generated line when the owner description is too short to be a snippet', async () => {
    // The live offender was a two-word description ("one day"), which renders
    // as a search snippet that says nothing about the playlist.
    mockGetPlaylistOgSummary.mockResolvedValue({ ...baseSummary, description: 'one day' });

    const metadata = await generatePlaylistMetadata('pl-1', 'en-US');

    expect(metadata.description).toBe(
      '12 Kilter climbs in Crimpy warm-ups. Open the playlist in Boardsesh and climb them.',
    );
  });

  it('keeps an owner description that is long enough to describe the playlist', async () => {
    const ownerDescription = 'Thirty moves of shoulder-friendly crimping to start a session';
    mockGetPlaylistOgSummary.mockResolvedValue({ ...baseSummary, description: ownerDescription });

    const metadata = await generatePlaylistMetadata('pl-1', 'en-US');

    expect(metadata.description).toBe(ownerDescription);
  });

  it('treats a whitespace-only owner description as absent', async () => {
    mockGetPlaylistOgSummary.mockResolvedValue({ ...baseSummary, description: '                                   ' });

    const metadata = await generatePlaylistMetadata('pl-1', 'en-US');

    expect(metadata.description).toContain('Crimpy warm-ups');
  });

  it('names the playlist and its board, so two playlists never share a description', async () => {
    mockGetPlaylistOgSummary.mockResolvedValue({
      ...baseSummary,
      name: 'Tension slopers',
      boardType: 'tension',
      climbCount: 1,
    });

    const metadata = await generatePlaylistMetadata('pl-2', 'en-US');

    expect(metadata.description).toBe(
      '1 Tension climb in Tension slopers. Open the playlist in Boardsesh and climb it.',
    );
  });
});

describe('generatePlaylistMetadata robots', () => {
  it('leaves a public playlist indexable', async () => {
    const metadata = await generatePlaylistMetadata('pl-1', 'en-US');

    expect(metadata.robots).toBeUndefined();
    expect(metadata.alternates?.canonical).toContain('/playlists/pl-1');
  });

  it('noindexes a private playlist', async () => {
    mockGetPlaylistOgSummary.mockResolvedValue({ ...baseSummary, isPublic: false });

    const metadata = await generatePlaylistMetadata('pl-1', 'en-US');

    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it('still answers for a summary the SQL read cannot find — the page body owns the 404', async () => {
    // Deliberate asymmetry with `page.tsx`, which calls `notFound()`: this
    // branch reads a different query, and a 404 from the body discards this
    // metadata anyway. Deleting it as dead code would break the disagreement case.
    mockGetPlaylistOgSummary.mockResolvedValue(null);

    const metadata = await generatePlaylistMetadata('pl-missing', 'en-US');

    expect(metadata.robots).toEqual({ index: false, follow: true });
  });
});
