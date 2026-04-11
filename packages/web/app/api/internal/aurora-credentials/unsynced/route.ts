import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { getDb } from "@/app/lib/db/db";
import { auroraCredentials, boardseshTicks, boardClimbs } from "@/app/lib/db/schema";
import { eq, and, isNull, count } from "drizzle-orm";
import { authOptions } from "@/app/lib/auth/auth-options";
import { AURORA_BOARDS, type AuroraBoardName } from "@boardsesh/shared-schema";

export type UnsyncedCounts = Record<AuroraBoardName, { ascents: number; climbs: number }>;

function createEmptyCounts(): UnsyncedCounts {
  return Object.fromEntries(
    AURORA_BOARDS.map((board) => [board, { ascents: 0, climbs: 0 }]),
  ) as UnsyncedCounts;
}

function isAuroraBoardName(value: string): value is AuroraBoardName {
  return (AURORA_BOARDS as readonly string[]).includes(value);
}

/**
 * GET - Get count of unsynced items for the logged-in user's Aurora accounts
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = getDb();

    // Get user's Aurora account user IDs from credentials
    const credentials = await db
      .select({
        boardType: auroraCredentials.boardType,
        auroraUserId: auroraCredentials.auroraUserId,
      })
      .from(auroraCredentials)
      .where(eq(auroraCredentials.userId, session.user.id));

    const counts: UnsyncedCounts = createEmptyCounts();

    for (const cred of credentials) {
      if (!cred.auroraUserId) continue;
      if (!isAuroraBoardName(cred.boardType)) continue;

      const boardType = cred.boardType;

      // Count unsynced ticks (ascents/bids) for this user from boardsesh_ticks
      // Note: boardsesh_ticks uses NextAuth userId, not Aurora user_id
      // Unsynced ticks are those without an auroraId
      const [ascentResult] = await db
        .select({ count: count() })
        .from(boardseshTicks)
        .where(
          and(
            eq(boardseshTicks.userId, session.user.id),
            eq(boardseshTicks.boardType, boardType),
            isNull(boardseshTicks.auroraId),
          ),
        );

      // Count unsynced climbs for this user
      const [climbResult] = await db
        .select({ count: count() })
        .from(boardClimbs)
        .where(
          and(
            eq(boardClimbs.boardType, boardType),
            eq(boardClimbs.setterId, cred.auroraUserId),
            eq(boardClimbs.synced, false),
          ),
        );

      counts[boardType] = {
        ascents: ascentResult?.count ?? 0,
        climbs: climbResult?.count ?? 0,
      };
    }

    return NextResponse.json({ counts });
  } catch (error) {
    console.error("Failed to get unsynced counts:", error);
    return NextResponse.json({ error: "Failed to get unsynced counts" }, { status: 500 });
  }
}
