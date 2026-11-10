// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { BOARD_RENDER_VERSION } from '@boardsesh/board-render/version';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    locale: 'en-US',
  })),
}));

vi.mock('@/app/lib/backend-url', () => ({
  getPublicBackendHttpUrl: () => 'https://ws.boardsesh.com',
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
  gradeSummary: null as { p10Difficulty: number; p90Difficulty: number } | null,
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

describe('generatePlaylistMetadata share preview', () => {
  it('points at the backend playlist card with the data token', async () => {
    const metadata = await generatePlaylistMetadata('pl-1', 'en-US');
    const [image] = (metadata.openGraph?.images ?? []) as Array<{ url: string }>;

    expect(image.url).toBe(`https://ws.boardsesh.com/og/playlist?uuid=pl-1&v=${BOARD_RENDER_VERSION}-v1`);
    expect(metadata.twitter?.images).toEqual([
      `https://ws.boardsesh.com/og/playlist?uuid=pl-1&v=${BOARD_RENDER_VERSION}-v1`,
    ]);
  });

  it('leads with the grade band, as the card does, and keeps the creator off both lines', async () => {
    // Kilter difficulty 20 is 6c/V5 and 26 is 7c/V9.
    mockGetPlaylistOgSummary.mockResolvedValue({
      ...baseSummary,
      name: 'Benchmarks - vukylebeta',
      climbCount: 117,
      gradeSummary: { p10Difficulty: 20, p90Difficulty: 26 },
    });

    const metadata = await generatePlaylistMetadata('pl-1', 'en-US');

    expect(metadata.openGraph?.title).toBe('Benchmarks - vukylebeta · V5–V9 Kilter list');
    expect(metadata.openGraph?.description).toBe('117 Kilter climbs from V5 to V9. Pick one and get on the wall.');
    // The search title stays the playlist's own name.
    expect(metadata.title).toEqual({ absolute: 'Benchmarks - vukylebeta | Boardsesh' });
  });

  it('says one grade once when the whole band is one V-grade', async () => {
    mockGetPlaylistOgSummary.mockResolvedValue({
      ...baseSummary,
      gradeSummary: { p10Difficulty: 20, p90Difficulty: 21 },
    });

    const metadata = await generatePlaylistMetadata('pl-1', 'en-US');

    expect(metadata.openGraph?.title).toBe('Crimpy warm-ups · V5 Kilter list');
    expect(metadata.openGraph?.description).toBe('12 Kilter climbs at V5. Pick one and get on the wall.');
  });

  it('falls back to the count when the list has no band', async () => {
    const metadata = await generatePlaylistMetadata('pl-1', 'en-US');

    expect(metadata.openGraph?.title).toBe('Crimpy warm-ups · Kilter list');
    expect(metadata.openGraph?.description).toBe('12 Kilter climbs. Pick one and get on the wall.');
  });

  it("lets an owner's real description win the preview too", async () => {
    const ownerDescription = 'Thirty moves of shoulder-friendly crimping to start a session';
    mockGetPlaylistOgSummary.mockResolvedValue({ ...baseSummary, description: ownerDescription });

    const metadata = await generatePlaylistMetadata('pl-1', 'en-US');

    expect(metadata.openGraph?.description).toBe(ownerDescription);
  });

  it('advertises no card for a private playlist, which the backend would 404', async () => {
    mockGetPlaylistOgSummary.mockResolvedValue({ ...baseSummary, isPublic: false });

    const metadata = await generatePlaylistMetadata('pl-1', 'en-US');

    expect(metadata.openGraph?.images).toBeUndefined();
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
