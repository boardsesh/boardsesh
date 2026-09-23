import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETS } from '@boardsesh/board-constants';
import { describe, expect, it } from 'vitest';
import { MAX_SET_IDS, ogClimbQuerySchema } from '../validation';

/**
 * Anchor the firmware reads on the workspace root, not on this file's depth.
 *
 * These paths leave the package, and a `../../../../../` prefix is only correct
 * while this test sits exactly five directories down. Moving the file — or the
 * package — would turn a tripwire into a read error at the one moment nobody is
 * thinking about firmware.
 */
function findWorkspaceRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, 'pnpm-workspace.yaml'))) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('no pnpm-workspace.yaml above this test, so the firmware sources cannot be located');
    }
    directory = parent;
  }
  return directory;
}

const WORKSPACE_ROOT = findWorkspaceRoot();

/**
 * Read one `static const` declaration out of a firmware source file.
 *
 * The constants below live in C++ that no TypeScript build ever sees, so the
 * only way to hold them to the server's number is to read the source. The
 * symbol is named explicitly rather than matched loosely: a second constant
 * whose name merely ends the same way must not be able to satisfy the check.
 */
function readFirmwareConstant(relativePath: string, symbol: string): number {
  const absolutePath = join(WORKSPACE_ROOT, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`${relativePath} is gone; this test no longer guards the firmware it names`);
  }
  const declaration = new RegExp(String.raw`\b${symbol}\s*=\s*(\d+)`).exec(readFileSync(absolutePath, 'utf8'));
  if (!declaration) throw new Error(`${symbol} is no longer declared in ${relativePath}`);
  return Number(declaration[1]);
}

/**
 * Tripwire for the render routes' hold-set ceiling.
 *
 * A board's `set_ids` are not a request parameter a caller chooses — they are
 * the whole hold-set list for that config, handed to us by the catalogue. So a
 * cap below the widest shipped config is not a safety bound, it is an outage
 * for that board: `MAX_SET_IDS = 10` against Decoy's 19 sets 400'd every Decoy
 * climb's share card and its server-rendered board image, and did so quietly,
 * because both the app's browser workers and the mobile app render the overlay
 * locally and never touch the HTTP endpoint.
 *
 * If a future board outgrows the cap, that must surface here.
 */
describe('every catalogue config fits under MAX_SET_IDS', () => {
  // `SETS` is keyed `"<layoutId>-<sizeId>"`. Split it here rather than inside the
  // schema assertion so a key that stops matching that shape fails as a key
  // problem, instead of surfacing as a set_ids rejection and sending the next
  // reader after the wrong constant.
  const configs = Object.entries(SETS).flatMap(([boardName, byLayoutAndSize]) =>
    Object.entries(byLayoutAndSize).map(([layoutAndSize, sets]) => {
      const [layoutId, sizeId, ...rest] = layoutAndSize.split('-');
      return {
        label: `${boardName}/${layoutAndSize}`,
        boardName,
        layoutId,
        sizeId,
        hasWellFormedKey: rest.length === 0 && /^\d+$/.test(layoutId) && /^\d+$/.test(sizeId ?? ''),
        setIds: sets.map((set) => set.id),
      };
    }),
  );

  it('covers every Aurora board in the catalogue', () => {
    // Name the boards instead of counting configs: a board dropped from a future
    // catalogue snapshot still clears any aggregate threshold, and walking `SETS`
    // is only worth doing if it is actually the whole catalogue.
    //
    // `SETS` also carries `moonboard`, `woods` and `spray` as empty objects —
    // their hold sets are not sourced from the Aurora tables this table is
    // generated from, so they are out of scope here rather than missing. Both
    // lists are asserted so a board moving between them is a red test.
    const boardsWithConfigs = [...new Set(configs.map((config) => config.boardName))].sort();
    const boardsWithoutConfigs = Object.keys(SETS)
      .filter((boardName) => !boardsWithConfigs.includes(boardName))
      .sort();

    expect(boardsWithConfigs).toEqual(['decoy', 'grasshopper', 'kilter', 'soill', 'tension', 'touchstone']);
    expect(boardsWithoutConfigs).toEqual(['moonboard', 'spray', 'woods']);
  });

  it('leaves the widest config under the cap', () => {
    const widest = configs.reduce((worst, config) => (config.setIds.length > worst.setIds.length ? config : worst));

    expect(
      widest.setIds.length,
      `${widest.label} carries ${widest.setIds.length} hold sets, over the MAX_SET_IDS cap of ${MAX_SET_IDS} in ` +
        'validation.ts. Raise the cap rather than letting every climb on that board 400 on /og/climb and ' +
        '/render/board.',
    ).toBeLessThanOrEqual(MAX_SET_IDS);
  });

  it('keys every config as layoutId-sizeId', () => {
    const malformed = configs.filter((config) => !config.hasWellFormedKey);

    expect(malformed.map((config) => config.label)).toEqual([]);
  });

  it('leaves the widest config inside the firmware route buffer', () => {
    // The board display firmware carries `set_ids` through fixed buffers sized
    // `MAX_ROUTE_SEGMENT` (96) in embedded/libs/thumbnail-client. A longer list
    // is not truncated — `copySegment` refuses it and the whole route is
    // dropped, which shows as a blank thumbnail on the wall. A set count inside
    // MAX_SET_IDS can still overflow it if the ids themselves get long enough,
    // so assert the characters and not just the count.
    const FIRMWARE_ROUTE_SEGMENT_BYTES = readFirmwareConstant(
      'embedded/libs/thumbnail-client/src/thumbnail_client.h',
      'MAX_ROUTE_SEGMENT',
    );
    const widest = configs.reduce((worst, config) => {
      const length = config.setIds.join(',').length;
      return length > worst.setIds.join(',').length ? config : worst;
    });
    const encoded = widest.setIds.join(',');

    expect(
      encoded.length,
      `${widest.label} encodes to ${encoded.length} characters, past what the firmware route buffer holds. ` +
        'Raise MAX_ROUTE_SEGMENT in embedded/libs/thumbnail-client/src/thumbnail_client.h to match.',
    ).toBeLessThan(FIRMWARE_ROUTE_SEGMENT_BYTES);
  });

  it('agrees with both firmware copies of the cap', () => {
    // Two C++ translation units declare this independently, in separate
    // binaries with no `#include` between them. A future edit to one is
    // otherwise invisible until a board renders short on the wall.
    const thumbnailClient = readFirmwareConstant(
      'embedded/libs/thumbnail-client/src/thumbnail_client.cpp',
      'MAX_SET_IDS',
    );
    const boardController = readFirmwareConstant(
      'embedded/projects/board-controller/src/board_config_key.h',
      'BOARD_CONFIG_MAX_SET_IDS',
    );

    expect(thumbnailClient).toBe(MAX_SET_IDS);
    expect(boardController).toBe(MAX_SET_IDS);
  });

  it('accepts every config through the og:climb query schema', () => {
    const rejected = configs.map((config) => ({
      label: config.label,
      issues: ogClimbQuerySchema
        .safeParse({
          board_name: config.boardName,
          layout_id: config.layoutId,
          size_id: config.sizeId,
          set_ids: config.setIds.join(','),
          frames: 'p1r1',
        })
        .error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    }));

    // Report the schema's own message, so a rejection names the field it came
    // from rather than leaving the reader to guess it was set_ids.
    expect(rejected.filter((config) => (config.issues?.length ?? 0) > 0)).toEqual([]);
  });
});
