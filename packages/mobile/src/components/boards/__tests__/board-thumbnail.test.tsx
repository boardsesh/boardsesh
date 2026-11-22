// @vitest-environment jsdom
// BoardThumbnail: the board keeps its own shape inside the art slot with a
// hairline on the art (no grey tile), the 400px render width that shares the
// raster cache, and the two placeholders: boards for an unknown config, camera
// for a spray wall until its photo is on disk.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { sprayBackgroundKey } from '../../../lib/spray/spray-photo-keys';

type RenderData = { boardWidth: number; boardHeight: number; backgroundImageKeys: string[] };

const ctrl = vi.hoisted(() => ({
  renderData: null as RenderData | null,
  photoOnDisk: false,
  resolveDownload: null as ((path: string | null) => void) | null,
  downloads: 0,
  privacyGeneration: 1,
  preview: null as { uri: string; aspectRatio: number } | null,
  thumbnailRequests: [] as { wallUuid: string; layoutId: number; draftVersionId: string | null }[],
}));

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../../test/flatten-style');
  return {
    Platform: { OS: 'ios' },
    PlatformColor: (name: string) => name,
    DynamicColorIOS: (appearances: { light: string }) => appearances.light,
    StyleSheet: { create: <T,>(styles: T): T => styles, hairlineWidth: 0.5, absoluteFill: { position: 'absolute' } },
    Image: ({ source, onLoad, onError }: { source: { uri: string }; onLoad: () => void; onError: () => void }) =>
      createElement('img', { 'data-testid': 'spray-photo', src: source.uri, onLoad, onError }),
    View: ({
      children,
      style,
      testID,
      accessible,
      accessibilityRole,
      accessibilityLabel,
      accessibilityElementsHidden,
    }: {
      children?: ReactNode;
      style?: unknown;
      testID?: string;
      accessible?: boolean;
      accessibilityRole?: string;
      accessibilityLabel?: string;
      accessibilityElementsHidden?: boolean;
    }) =>
      createElement(
        'div',
        {
          'data-testid': testID,
          'data-style': JSON.stringify(flattenStyle(style)),
          'data-accessible': accessible === undefined ? undefined : String(accessible),
          role: accessibilityRole === 'image' ? 'img' : undefined,
          'aria-label': accessibilityLabel,
          'aria-hidden': accessibilityElementsHidden ? 'true' : undefined,
        },
        children,
      ),
  };
});
vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: ({ boardName, renderWidth, frames }: { boardName: string; renderWidth: number; frames: string }) =>
    createElement('canvas', {
      'data-testid': 'board-art',
      'data-board': boardName,
      'data-width': renderWidth,
      'data-frames': frames,
    }),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, size, color }: { name: string; size: number; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-size': size, 'data-color': color }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { separator: '#SEPARATOR', tertiaryLabel: '#TERTIARY' } }),
}));
vi.mock('../../../lib/board-details', () => ({ getBoardRenderData: () => ctrl.renderData }));
vi.mock('../../../lib/spray/use-spray-wall-token', () => ({ useSprayWallToken: () => '' }));
vi.mock('../../../lib/spray/use-spray-wall-thumbnail', () => ({
  useSprayWallThumbnail: (request: { wallUuid: string; layoutId: number; draftVersionId: string | null }) => {
    ctrl.thumbnailRequests.push(request);
    return ctrl.preview;
  },
}));
vi.mock('../../../lib/spray/spray-privacy-generation', () => ({
  sprayPrivacyGeneration: () => `generation-${ctrl.privacyGeneration}`,
}));
vi.mock('../../../lib/spray/spray-photo-cache', () => ({
  tryGetSprayPhotoPathSync: () => (ctrl.photoOnDisk ? '/cache/spray.jpg' : null),
  ensureSprayPhotoCached: () => {
    ctrl.downloads += 1;
    return new Promise<string | null>((resolve) => {
      ctrl.resolveDownload = resolve;
    });
  },
}));

import { BoardThumbnail } from '../BoardThumbnail';
import { DiscoveryBoardArt } from '../../board-discovery/DiscoveryBoardArt';

const KILTER = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };
const SPRAY = { boardType: 'spray', layoutId: 9001, sizeId: 9001, setIds: '1' };

function styleOf(element: Element | null | undefined): Record<string, unknown> {
  return JSON.parse(element?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
}

/** The box the art sits in: the parent of the renderer. */
function artBox(): Element | null {
  return screen.getByTestId('board-art').parentElement;
}

beforeEach(() => {
  ctrl.renderData = { boardWidth: 1000, boardHeight: 1000, backgroundImageKeys: ['kilter/original.png'] };
  ctrl.photoOnDisk = false;
  ctrl.resolveDownload = null;
  ctrl.downloads = 0;
  ctrl.privacyGeneration = 1;
  ctrl.preview = null;
  ctrl.thumbnailRequests = [];
});
afterEach(cleanup);

describe('BoardThumbnail', () => {
  it('fits a square board inside the regular 44×56 slot, with no tile behind it', () => {
    const { container } = render(<BoardThumbnail board={KILTER} size="regular" />);
    const slot = styleOf(container.firstElementChild);
    expect(slot.width).toBe(44);
    expect(slot.height).toBe(56);
    expect(slot.backgroundColor).toBeUndefined();
    const box = styleOf(artBox());
    expect(box.width).toBe(44);
    expect(box.height).toBe(44);
    expect(box.backgroundColor).toBeUndefined();
  });

  it('keeps a tall board tall: a portrait board fills the slot height, not its width', () => {
    ctrl.renderData = { boardWidth: 600, boardHeight: 1000, backgroundImageKeys: ['moonboard/2024.png'] };
    render(<BoardThumbnail board={KILTER} size="regular" />);
    const box = styleOf(artBox());
    expect(box.height).toBe(56);
    expect(box.width).toBeCloseTo(33.6);
  });

  it('draws a hairline in the separator colour on the art itself', () => {
    render(<BoardThumbnail board={KILTER} size="regular" />);
    const overlay = artBox()?.lastElementChild;
    const border = styleOf(overlay);
    expect(border.borderColor).toBe('#SEPARATOR');
    expect(border.borderWidth).toBe(0.5);
    expect(border.position).toBe('absolute');
  });

  it('renders at 400px wide whatever the slot, so the raster cache is shared', () => {
    render(<BoardThumbnail board={KILTER} size={96} />);
    expect(screen.getByTestId('board-art').getAttribute('data-width')).toBe('400');
    expect(screen.getByTestId('board-art').getAttribute('data-frames')).toBe('');
    expect(styleOf(artBox()).width).toBe(96);
  });

  it('sizes the compact slot at 36×44', () => {
    const { container } = render(<BoardThumbnail board={KILTER} size="compact" />);
    const slot = styleOf(container.firstElementChild);
    expect(slot.width).toBe(36);
    expect(slot.height).toBe(44);
  });

  it('shows the boards glyph in an empty hairline slot when the catalogue cannot draw it', () => {
    ctrl.renderData = null;
    const { container } = render(<BoardThumbnail board={KILTER} size="regular" />);
    expect(screen.queryByTestId('board-art')).toBeNull();
    const glyph = container.querySelector('[data-icon="boards"]');
    expect(glyph?.getAttribute('data-color')).toBe('#TERTIARY');
    const placeholder = styleOf(glyph?.parentElement);
    expect(placeholder.width).toBe(44);
    expect(placeholder.height).toBe(56);
    expect(placeholder.borderColor).toBe('#SEPARATOR');
    expect(placeholder.backgroundColor).toBeUndefined();
  });

  it('shows a spray wall’s camera until its photo is on disk, then the photo', async () => {
    ctrl.renderData = {
      boardWidth: 3000,
      boardHeight: 4000,
      backgroundImageKeys: [sprayBackgroundKey(9001, 7)],
    };
    const { container } = render(<BoardThumbnail board={SPRAY} size="regular" />);
    expect(screen.queryByTestId('board-art')).toBeNull();
    const camera = container.querySelector('[data-icon="camera"]');
    expect(Number(camera?.getAttribute('data-size'))).toBeGreaterThanOrEqual(22);
    expect(Number(camera?.getAttribute('data-size'))).toBeLessThanOrEqual(28);
    expect(ctrl.downloads).toBe(1);
    await act(async () => {
      ctrl.resolveDownload?.('/cache/spray.jpg');
    });
    expect(screen.getByTestId('board-art').getAttribute('data-board')).toBe('spray');
  });

  it('draws a spray wall whose photo is already on disk on the first frame', () => {
    ctrl.photoOnDisk = true;
    ctrl.renderData = { boardWidth: 3000, boardHeight: 4000, backgroundImageKeys: [sprayBackgroundKey(9001, 7)] };
    render(<BoardThumbnail board={SPRAY} size="regular" />);
    expect(screen.getByTestId('board-art')).toBeTruthy();
    expect(ctrl.downloads).toBe(0);
  });

  it('keeps the camera when the photo download fails', async () => {
    ctrl.renderData = { boardWidth: 3000, boardHeight: 4000, backgroundImageKeys: [sprayBackgroundKey(9001, 7)] };
    const { container } = render(<BoardThumbnail board={SPRAY} size="regular" />);
    await act(async () => {
      ctrl.resolveDownload?.(null);
    });
    expect(screen.queryByTestId('board-art')).toBeNull();
    expect(container.querySelector('[data-icon="camera"]')).not.toBeNull();
  });

  it('forgets a finished download when the wall is withdrawn and registered again', async () => {
    ctrl.renderData = { boardWidth: 3000, boardHeight: 4000, backgroundImageKeys: [sprayBackgroundKey(9001, 7)] };
    const { rerender } = render(<BoardThumbnail board={SPRAY} size="regular" />);
    await act(async () => {
      ctrl.resolveDownload?.('/cache/spray.jpg');
    });
    expect(screen.getByTestId('board-art')).toBeTruthy();
    // Same version, same background key, but a new privacy generation: the old
    // download no longer vouches for the file, so it asks the cache again.
    ctrl.privacyGeneration = 2;
    rerender(<BoardThumbnail board={{ ...SPRAY }} size="regular" />);
    expect(screen.queryByTestId('board-art')).toBeNull();
    expect(ctrl.downloads).toBe(2);
    await act(async () => {
      ctrl.resolveDownload?.('/cache/spray.jpg');
    });
    expect(screen.getByTestId('board-art')).toBeTruthy();
  });

  it('shows the camera for a spray wall the registry has not loaded', () => {
    ctrl.renderData = null;
    const { container } = render(<BoardThumbnail board={SPRAY} size="compact" />);
    expect(container.querySelector('[data-icon="camera"]')).not.toBeNull();
    expect(ctrl.downloads).toBe(0);
  });

  it('is hidden from VoiceOver by default, and an image of the board type when asked', () => {
    const { container } = render(<BoardThumbnail board={KILTER} size="regular" />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    cleanup();
    render(<BoardThumbnail board={KILTER} size="regular" accessibilityHidden={false} />);
    expect(screen.getByRole('img', { name: 'Kilter' })).toBeTruthy();
  });

  it('loads saved spray previews by UUID without requiring published render geometry', () => {
    ctrl.renderData = null;
    ctrl.preview = { uri: 'file:///cache/spray.jpg', aspectRatio: 0.75 };
    render(<BoardThumbnail board={{ ...SPRAY, uuid: 'shared-wall' }} size="regular" />);
    expect(ctrl.thumbnailRequests).toEqual([{ wallUuid: 'shared-wall', layoutId: 9001, draftVersionId: null }]);
    expect(screen.getByTestId('spray-photo').getAttribute('src')).toBe('file:///cache/spray.jpg');
    expect(screen.queryByTestId('board-art')).toBeNull();
    expect(ctrl.downloads).toBe(0);
  });

  it('passes the picker wall UUID and unfinished version to the photo preview', () => {
    render(
      <DiscoveryBoardArt
        item={{
          key: 'unfinished-wall',
          boardName: 'spray',
          layoutId: 9001,
          sizeId: 9001,
          setIds: '1',
          title: 'Garage',
          sprayImport: {
            wallUuid: 'unfinished-wall',
            versionId: '42',
            stage: 'ready',
            detectionId: null,
            queuePosition: null,
            retryAt: null,
            resetOfWallUuid: null,
          },
        }}
        size="regular"
      />,
    );
    expect(ctrl.thumbnailRequests).toEqual([{ wallUuid: 'unfinished-wall', layoutId: 9001, draftVersionId: '42' }]);
    expect(screen.queryByTestId('spray-photo')).toBeNull();
  });

  it('replaces the saved wall camera when its photo arrives and reports image readiness', () => {
    const onArtReadinessChange = vi.fn();
    const board = { ...SPRAY, uuid: 'shared-wall' };
    const { container, rerender } = render(
      <BoardThumbnail board={board} size="regular" onArtReadinessChange={onArtReadinessChange} />,
    );
    expect(container.querySelector('[data-icon="camera"]')).not.toBeNull();
    ctrl.preview = { uri: 'https://example.invalid/photo.jpg', aspectRatio: 0.75 };
    rerender(<BoardThumbnail board={{ ...board }} size="regular" onArtReadinessChange={onArtReadinessChange} />);
    fireEvent.load(screen.getByTestId('spray-photo'));
    expect(onArtReadinessChange).toHaveBeenCalledWith('ready');
    expect(container.querySelector('[data-icon="camera"]')).toBeNull();
    fireEvent.error(screen.getByTestId('spray-photo'));
    expect(onArtReadinessChange).toHaveBeenCalledWith('failed');
    expect(container.querySelector('[data-icon="camera"]')).not.toBeNull();
  });
});
