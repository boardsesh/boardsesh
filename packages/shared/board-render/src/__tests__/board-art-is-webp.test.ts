import { describe, expect, it } from 'vitest';
import { getBackgroundRelPaths } from '../background';
import { getBoardDetailsForBoard } from '../board-details';
import { listCatalogueEntries } from '../render-version-projection';

/**
 * Every board photo is committed twice: a `.png` and the `.webp` that
 * `packages/web/scripts/convert-to-webp.sh` makes from it. Only the WebP is ever
 * read — and the backend's Docker context now leaves the PNGs behind, which cut
 * the images tree it ships from 74 MB to 25 MB.
 *
 * That saving is only safe while this holds. A catalogue path that resolved to a
 * `.png` would exist in the repo, pass every test run from a developer's
 * checkout, and 404 only inside the built image.
 */
describe('board art resolves to WebP only', () => {
  // Walked ONCE, lazily, and every assertion reads the result.
  //
  // Once, because the second walk that used to be here carried its own
  // `catch {}` — so a board that stopped resolving vanished from the
  // dark-variant check while the light one still guarded it.
  //
  // Lazily, because at describe level a throw out of the catalogue takes the
  // whole file down as a collection error, with no test name attached to say
  // what broke.
  let walked: CatalogueWalk | undefined;
  const walkCatalogue = (): CatalogueWalk => (walked ??= collectCatalogueArt());

  it('resolves every catalogue entry', () => {
    const { entries } = walkCatalogue();

    expect(entries.filter((entry) => entry.failed).map((entry) => entry.label)).toEqual([]);
  });

  it('produces art for every board in the catalogue', () => {
    const { entries } = walkCatalogue();
    const boardsWithoutArt = [...new Set(entries.map((entry) => entry.boardName))].filter(
      (boardName) => !entries.some((entry) => entry.boardName === boardName && entry.relPaths.length > 0),
    );

    expect(boardsWithoutArt).toEqual([]);
  });

  it('covers the whole catalogue, full size and thumbnail', () => {
    expect(walkCatalogue().paths.length).toBeGreaterThan(100);
  });

  it('never asks for a raster the runtime image does not ship', () => {
    const notWebp = walkCatalogue().paths.filter(({ relPath }) => !relPath.endsWith('.webp'));

    expect(
      notWebp.map(({ label, relPath }) => `${label} → ${relPath}`),
      'the backend Docker context excludes .png; a non-WebP path here 404s only inside the image',
    ).toEqual([]);
  });

  it('asks for the dark variants as WebP too', () => {
    const darkPaths = walkCatalogue().entries.flatMap(({ label, darkRelPaths }) =>
      darkRelPaths.map((relPath) => ({ label, relPath })),
    );

    expect(darkPaths.length).toBeGreaterThan(0);
    expect(
      darkPaths
        .filter(({ relPath }) => !relPath.endsWith('.webp'))
        .map(({ label, relPath }) => `${label} → ${relPath}`),
    ).toEqual([]);
  });
});

type CatalogueEntryArt = {
  boardName: string;
  label: string;
  relPaths: string[];
  darkRelPaths: string[];
  failed: boolean;
};

type CatalogueWalk = {
  entries: CatalogueEntryArt[];
  paths: { label: string; relPath: string }[];
};

function collectCatalogueArt(): CatalogueWalk {
  const entries = listCatalogueEntries().map((entry): CatalogueEntryArt => {
    const label = `${entry.boardName}/${entry.layoutId}-${entry.sizeId}`;
    try {
      const details = getBoardDetailsForBoard({
        board_name: entry.boardName,
        layout_id: entry.layoutId,
        size_id: entry.sizeId,
        set_ids: entry.setIds,
      });
      return {
        boardName: entry.boardName,
        label,
        relPaths: [false, true].flatMap((thumbnail) => getBackgroundRelPaths(details, thumbnail)),
        darkRelPaths: getBackgroundRelPaths(details, false, 'dark'),
        // Recorded rather than swallowed: a board that stops resolving would
        // otherwise drop out of this walk silently, and a lower-bound count is
        // far too loose to notice a whole board type going missing.
        failed: false,
      };
    } catch {
      return { boardName: entry.boardName, label, relPaths: [], darkRelPaths: [], failed: true };
    }
  });

  return {
    entries,
    paths: entries.flatMap(({ label, relPaths }) => relPaths.map((relPath) => ({ label, relPath }))),
  };
}
