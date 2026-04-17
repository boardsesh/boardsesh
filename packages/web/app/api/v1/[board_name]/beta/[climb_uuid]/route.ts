import { NextRequest, NextResponse } from 'next/server';
import { dbz } from '@/app/lib/db/db';
import { eq, and } from 'drizzle-orm';
import { BoardName } from '@/app/lib/types';
import { extractUuidFromSlug } from '@/app/lib/url-utils';
import { UNIFIED_TABLES, isValidUnifiedBoardName } from '@/app/lib/db/queries/util/table-select';
import { filterAndRevalidateBetaLinks } from '@/app/lib/beta-link-revalidation';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ board_name: string; climb_uuid: string }> },
) {
  const { board_name: boardNameParam, climb_uuid: rawClimbUuid } = await params;
  const board_name = boardNameParam as BoardName;
  const climb_uuid = extractUuidFromSlug(rawClimbUuid);

  if (!isValidUnifiedBoardName(board_name)) {
    return NextResponse.json({ error: 'Invalid board name' }, { status: 400 });
  }

  try {
    const { betaLinks } = UNIFIED_TABLES;

    const results = await dbz
      .select()
      .from(betaLinks)
      .where(and(eq(betaLinks.boardType, board_name), eq(betaLinks.climbUuid, climb_uuid)));

    // Hide affirmatively-broken links and kick off background revalidation
    // for unknown/stale rows. Never blocks the response.
    const visible = filterAndRevalidateBetaLinks(results);

    const transformedLinks = visible.map((link) => ({
      climb_uuid: link.climbUuid,
      link: link.link,
      foreign_username: link.foreignUsername,
      angle: link.angle,
      thumbnail: link.thumbnail,
      is_listed: link.isListed,
      created_at: link.createdAt,
    }));

    return NextResponse.json(transformedLinks);
  } catch (error) {
    console.error('Error fetching beta links:', error);
    return NextResponse.json({ error: 'Failed to fetch beta links' }, { status: 500 });
  }
}
