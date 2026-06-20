import { and, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type { ConnectionContext, InstagramBetaScanInput, InstagramBetaScanResult } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { dbRead } from '../../../db/client';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { InstagramBetaScanInputSchema } from '../../../validation/schemas';
import {
  classifyScanPosts,
  climbNameKey,
  existingShortcodeSet,
  normalizeName,
  parseScanPosts,
  type ScanClimbRow,
} from './instagram-beta-import-classify';

export const instagramBetaImportQueries = {
  // Scan scraped Instagram posts against the catalog: parse each caption,
  // resolve the climb name, dedupe against existing beta links, and bucket
  // every post into missing / alreadyLinked / ambiguous / unmatched. Read-only
  // (no writes) — the user reviews the plan and attaches via attachBetaLink.
  instagramBetaScan: async (
    _parent: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<InstagramBetaScanResult> => {
    requireAuthenticated(ctx);
    // Bound the per-user call rate: each scan fans out one name-resolution and
    // one dedup query over the catalog, and the scraped payload is attacker-
    // controllable. 30/min is well above interactive review use.
    await applyRateLimit(ctx, 30, 'instagram-beta-scan');

    const validated: InstagramBetaScanInput = validateInput(InstagramBetaScanInputSchema, input, 'input');

    const parsedPosts = parseScanPosts(validated.posts, validated.boardType);

    // Empty / all-unparseable payload: no name to resolve and no board to
    // dedup against, so skip both queries and classify with empty lookups.
    const parsedWithName = parsedPosts.filter((post) => post.parsedName !== null);
    if (parsedWithName.length === 0) {
      return classifyScanPosts(parsedPosts, new Map(), new Set(), new Map());
    }

    // Resolve every distinct (board, lower-name) pair in ONE query: group the
    // names per board and OR the per-board conditions together. `lower(name)`
    // matches the script's case-insensitive resolution.
    const namesByBoard = new Map<string, Set<string>>();
    for (const post of parsedWithName) {
      const names = namesByBoard.get(post.resolvedBoardType) ?? new Set<string>();
      names.add(normalizeName(post.parsedName));
      namesByBoard.set(post.resolvedBoardType, names);
    }
    const boardsSeen = [...namesByBoard.keys()];

    const nameConditions: SQL[] = [];
    for (const [boardType, names] of namesByBoard) {
      nameConditions.push(
        and(
          eq(dbSchema.boardClimbs.boardType, boardType),
          inArray(sql`lower(${dbSchema.boardClimbs.name})`, [...names]),
        ) as SQL,
      );
    }

    const climbRows = await dbRead
      .select({
        uuid: dbSchema.boardClimbs.uuid,
        name: dbSchema.boardClimbs.name,
        boardType: dbSchema.boardClimbs.boardType,
        layoutId: dbSchema.boardClimbs.layoutId,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        isListed: dbSchema.boardClimbs.isListed,
        isDraft: dbSchema.boardClimbs.isDraft,
        angle: dbSchema.boardClimbs.angle,
      })
      .from(dbSchema.boardClimbs)
      .where(
        and(
          isNotNull(dbSchema.boardClimbs.name),
          nameConditions.length === 1 ? nameConditions[0] : or(...nameConditions),
        ),
      );

    const climbsByName = new Map<string, ScanClimbRow[]>();
    for (const row of climbRows) {
      if (row.name === null) continue;
      const climb: ScanClimbRow = { ...row, name: row.name };
      const key = climbNameKey(climb.boardType, climb.name);
      const list = climbsByName.get(key) ?? [];
      list.push(climb);
      climbsByName.set(key, list);
    }

    // Dedup: pull existing links for every board seen and reduce to the set of
    // IG shortcodes already attached, with a representative climb per shortcode.
    const existingLinks = await dbRead
      .select({
        climbUuid: dbSchema.boardBetaLinks.climbUuid,
        link: dbSchema.boardBetaLinks.link,
      })
      .from(dbSchema.boardBetaLinks)
      .where(inArray(dbSchema.boardBetaLinks.boardType, boardsSeen));

    const { shortcodes, climbByShortcode } = existingShortcodeSet(existingLinks);

    return classifyScanPosts(parsedPosts, climbsByName, shortcodes, climbByShortcode);
  },
};
