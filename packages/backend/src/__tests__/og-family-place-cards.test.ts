import { describe, expect, it, vi } from 'vite-plus/test';
import sharp from 'sharp';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import type { BoardConfig } from '../services/og-family/card-model';
import { isRenderableConfig } from '../services/og-family/card-model';
import {
  NO_BOARDS_LINE,
  boardConfigLine,
  buildBoardCardContent,
  buildGymCardContent,
  buildSprayCardContent,
  describeGymBoards,
  pickGymBoardConfig,
  stripDefaultBoardNameTail,
} from '../services/og-family/place-card-model';
import { decodeGymPhoto, resolveGymPhotoFetchUrl } from '../services/og-family/place-photo';
import { passSprayCardGates } from '../services/og-family/load-place-cards';
import {
  assertAllowedImageHost,
  fetchAllowedImage,
  TransientImageFetchError,
  UnsafeImageHostError,
} from '../lib/safe-image-fetch';
import { getBoardDetailsForBoard } from '@boardsesh/board-render';
import { BOARD_TYPE_LABELS } from '@boardsesh/board-constants';
import { listCatalogueEntries } from '@boardsesh/board-render/render-version-projection';
import type { SprayOgCardDeps, SprayOgWallRow } from '../services/spray-og-card';

vi.mock('node:dns/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns/promises')>()),
  lookup: vi.fn(async () => [{ address: '104.18.0.1', family: 4 }]),
}));

const kilter: BoardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };

describe('every board type has a card', () => {
  const catalogueBoards = SUPPORTED_BOARDS.filter((boardName) => boardName !== 'spray');

  it.each(catalogueBoards)('%s resolves a renderable default config', (boardName) => {
    const choice = pickGymBoardConfig([boardName], [{ boardType: boardName, angle: 25 }]);

    expect(choice).not.toBeNull();
    expect(choice?.config.boardName).toBe(boardName);
    expect(isRenderableConfig(choice!.config)).toBe(true);
    expect(choice?.angle).toBe(25);
  });

  it('draws no catalogue art for a gym with only a spray wall', () => {
    expect(pickGymBoardConfig(['spray'], [{ boardType: 'spray', angle: 40 }])).toBeNull();
  });

  it('prefers Kilter over an alphabetically earlier type', () => {
    expect(pickGymBoardConfig(['decoy', 'kilter'], [])?.config.boardName).toBe('kilter');
  });
});

describe('the boards line', () => {
  it('says the angle for one board at one angle', () => {
    expect(describeGymBoards(['kilter'], [{ boardType: 'kilter', angle: 30 }])).toBe('Kilter 30°');
  });

  it('drops the angle when one type has several', () => {
    expect(
      describeGymBoards(
        ['kilter'],
        [
          { boardType: 'kilter', angle: 30 },
          { boardType: 'kilter', angle: 45 },
        ],
      ),
    ).toBe('Kilter');
  });

  it('joins several types, with no number that is not about the gym', () => {
    const line = describeGymBoards(['kilter', 'moonboard'], [{ boardType: 'kilter', angle: 40 }]);

    expect(line).toBe('Kilter + MoonBoard');
    expect(line).not.toMatch(/\d/);
  });

  it('is null for a gym with no boards', () => {
    expect(describeGymBoards([], [])).toBeNull();
  });
});

describe('gym card content', () => {
  const base = { boardTypes: [], boardSummaries: [] };

  it('centres a gym with no art and says it has no boards', () => {
    const content = buildGymCardContent({ gym: { ...base, name: 'Pinnacle' }, hasArt: false, fontFamily: 'Noto' });

    expect(content.slot).toBe('none');
    expect(content.rows[0].runs[0].text).toBe(NO_BOARDS_LINE);
    expect(content.eyebrow).toBeUndefined();
  });

  it('falls back when a name has nothing drawable in it', () => {
    const content = buildGymCardContent({ gym: { ...base, name: '   ' }, hasArt: false, fontFamily: 'Noto' });

    expect(content.hero.runs[0].text).toBe('Climbing gym');
  });

  it('cuts a very long name at a word, with an ellipsis', () => {
    const name = `${'word '.repeat(30)}end`;
    const content = buildGymCardContent({ gym: { ...base, name }, hasArt: false, fontFamily: 'Noto' });
    const drawn = content.hero.runs[0].text;

    expect(drawn.endsWith('…')).toBe(true);
    expect(drawn).not.toMatch(/\swor…$/);
  });

  it.each([
    ['an ampersand', 'Rock & Roll <3'],
    ['right-to-left text', 'מרכז טיפוס'],
    ['CJK text', '東京ボルダリング'],
  ])('keeps %s intact in the hero', (_label, name) => {
    const content = buildGymCardContent({ gym: { ...base, name }, hasArt: true, fontFamily: 'Noto' });

    expect(content.hero.runs[0].text).toBe(name);
  });
});

describe('default board names', () => {
  it("strips the app's config tail", () => {
    expect(stripDefaultBoardNameTail("Marco's Kilter Original 12 x 12 with kickboard", kilter)).toBe("Marco's Kilter");
    expect(stripDefaultBoardNameTail("Marco's Kilter Original 12×12 with kickboard", kilter)).toBe("Marco's Kilter");
  });

  it('keeps the layout when the app made up a name with no owner', () => {
    expect(stripDefaultBoardNameTail('Kilter Original 12×12 with kickboard', kilter)).toBe('Kilter Original');
  });

  it('never collapses an ownerless default name to the brand, on any config', () => {
    const named = listCatalogueEntries().filter((entry) => entry.boardName !== 'spray');
    expect(named.length).toBeGreaterThan(40);
    for (const { boardName, layoutId, sizeId, setIds } of named) {
      const config: BoardConfig = { boardName, layoutId, sizeId, setIds: setIds.join(',') };
      const { layout_name: layoutName, size_name: sizeName } = getBoardDetailsForBoard({
        board_name: boardName,
        layout_id: layoutId,
        size_id: sizeId,
        set_ids: setIds,
      });
      const label = BOARD_TYPE_LABELS[boardName];
      const layout = (layoutName ?? '').replace(new RegExp(`\\b${label}\\b`, 'gi'), '').replace(/\bBoard\b/gi, '');

      expect(stripDefaultBoardNameTail(`${label} ${layout} ${sizeName}`.replace(/\s+/g, ' ').trim(), config)).not.toBe(
        label,
      );
    }
  });

  it('leaves a name somebody chose alone', () => {
    expect(stripDefaultBoardNameTail('Backspace', kilter)).toBe('Backspace');
    expect(stripDefaultBoardNameTail('The Original 12 x 12 with kickboard', kilter)).toBe(
      'The Original 12 x 12 with kickboard',
    );
  });

  it('leaves a spray wall alone', () => {
    const spray: BoardConfig = { boardName: 'spray', layoutId: 7, sizeId: 7, setIds: '1' };

    expect(stripDefaultBoardNameTail("Marco's Spray wall", spray)).toBe("Marco's Spray wall");
  });

  it('keeps a board with an unknown config whole', () => {
    expect(stripDefaultBoardNameTail('Anything', { ...kilter, layoutId: 999 })).toBe('Anything');
  });
});

describe('board card content', () => {
  it('reads the config line from the catalogue, without the brand or "high/wide"', () => {
    expect(boardConfigLine(kilter)).toBe('Original · 12 x 12 with kickboard');
    expect(boardConfigLine({ boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13' })).toBe(
      'Mirror · 12 x 12',
    );
  });

  it('draws no location when the schema returned none', () => {
    const content = buildBoardCardContent({
      board: {
        name: 'Home',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
        angle: 40,
        locationName: null,
      },
      config: kilter,
      hasArt: true,
      fontFamily: 'Noto',
    });

    expect(content.rows).toHaveLength(1);
  });
});

describe('spray card content', () => {
  it('says the hold count, singular when it is one', () => {
    const board = { name: 'Fold', angle: 40, locationName: null };

    expect(buildSprayCardContent({ board, holdCount: 1, fontFamily: 'Noto' }).eyebrow?.runs[0].text).toBe(
      'Spraywall · 1 hold',
    );
    expect(buildSprayCardContent({ board, holdCount: 1200, fontFamily: 'Noto' }).eyebrow?.runs[0].text).toBe(
      'Spraywall · 1,200 holds',
    );
  });
});

describe('gym photo url', () => {
  const media = 'https://media.boardsesh.com';

  it('maps the stored path to the media CDN, keeping its version', () => {
    expect(resolveGymPhotoFetchUrl('/static/gym-photos/a.jpg?v=3', media)).toBe(`${media}/gym-photos/a.jpg?v=3`);
  });

  it('refuses anything but the shape the upload writes', () => {
    expect(resolveGymPhotoFetchUrl('https://evil.example/a.jpg', media)).toBeNull();
    expect(resolveGymPhotoFetchUrl('/static/avatars/a.jpg', media)).toBeNull();
    expect(resolveGymPhotoFetchUrl('/static/gym-photos/a.jpg', null)).toBeNull();
  });
});

describe('the photo host kind', () => {
  it('admits the media CDN', async () => {
    await expect(assertAllowedImageHost('https://media.boardsesh.com/x.jpg', 'place-photo')).resolves.toBeUndefined();
  });

  it('refuses a host the avatar kind would accept', async () => {
    await expect(assertAllowedImageHost('https://lh3.googleusercontent.com/x', 'place-photo')).rejects.toBeInstanceOf(
      UnsafeImageHostError,
    );
  });
});

describe('which fetch failures are worth retrying', () => {
  const imageUrl = 'https://media.boardsesh.com/x.jpg';
  const answering = (status: number) =>
    vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('nope', { status, headers: { 'content-type': 'image/jpeg' } }));
  const options = { timeoutMs: 1000, maxBytes: 1000 };

  it.each([500, 503, 429])('treats %i as transient', async (status) => {
    const fetchStub = answering(status);

    await expect(fetchAllowedImage(imageUrl, 'place-photo', options)).rejects.toBeInstanceOf(TransientImageFetchError);
    fetchStub.mockRestore();
  });

  it.each([403, 404])('treats %i as final', async (status) => {
    const fetchStub = answering(status);

    const failure = await fetchAllowedImage(imageUrl, 'place-photo', options).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UnsafeImageHostError);
    expect(failure).not.toBeInstanceOf(TransientImageFetchError);
    fetchStub.mockRestore();
  });
});

describe('decodeGymPhoto', () => {
  it('crops to the art slot', async () => {
    const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#224466' } })
      .jpeg()
      .toBuffer();

    const photo = await decodeGymPhoto(bytes);

    expect(photo).toMatchObject({ width: 544, height: 602 });
    expect(await sharp(photo!.image).metadata()).toMatchObject({ format: 'jpeg', width: 544, height: 602 });
  });

  it('refuses SVG before sharp can read it', async () => {
    await expect(
      decodeGymPhoto(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"></svg>')),
    ).resolves.toBeNull();
  });

  it('refuses a GIF, which the upload path allows and this does not', async () => {
    const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#335577' } })
      .gif()
      .toBuffer();

    await expect(decodeGymPhoto(gif)).resolves.toBeNull();
  });

  it('throws for a corrupt JPEG, so the caller can fall back', async () => {
    await expect(decodeGymPhoto(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).rejects.toThrow();
  });

  it('refuses a decompression bomb past the pixel cap', async () => {
    const bomb = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: '#000000' } })
      .jpeg({ quality: 1 })
      .toBuffer();

    await expect(decodeGymPhoto(bomb)).rejects.toThrow();
  });
});

describe('passSprayCardGates', () => {
  const openWall: SprayOgWallRow = {
    wallId: 1,
    layoutId: 7,
    wallName: 'Fold',
    isPublic: true,
    hiddenAt: null,
    publicPhotoKey: 'spray-walls/a/key.jpg',
    currentVersionId: 3,
  };
  const version = { photoWidth: 800, photoHeight: 1200, homography: null };

  function deps(overrides: Partial<SprayOgCardDeps> = {}) {
    return {
      loadWall: vi.fn(async () => openWall),
      loadPublishedVersion: vi.fn(async () => version),
      publicPhotoUrl: vi.fn(() => 'https://media.boardsesh.com/x.jpg'),
      ...overrides,
    };
  }

  it('passes an open wall', async () => {
    await expect(passSprayCardGates(7, deps())).resolves.toMatchObject({ wall: openWall, version });
  });

  it.each<[string, Partial<SprayOgWallRow>]>([
    ['is not public', { isPublic: false }],
    ['is hidden', { hiddenAt: new Date() }],
    ['was never published', { currentVersionId: null }],
    ['has no public copy', { publicPhotoKey: null }],
  ])('refuses a wall that %s', async (_label, row) => {
    const gateDeps = deps({ loadWall: vi.fn(async () => ({ ...openWall, ...row })) });

    await expect(passSprayCardGates(7, gateDeps)).resolves.toBeNull();
    expect(gateDeps.loadPublishedVersion).not.toHaveBeenCalled();
  });

  it('refuses a wall that does not exist', async () => {
    await expect(passSprayCardGates(7, deps({ loadWall: vi.fn(async () => null) }))).resolves.toBeNull();
  });

  it('refuses when no public URL can be derived', async () => {
    await expect(passSprayCardGates(7, deps({ publicPhotoUrl: vi.fn(() => null) }))).resolves.toBeNull();
  });

  it('refuses a wall whose published version row is gone', async () => {
    await expect(passSprayCardGates(7, deps({ loadPublishedVersion: vi.fn(async () => null) }))).resolves.toBeNull();
  });
});
