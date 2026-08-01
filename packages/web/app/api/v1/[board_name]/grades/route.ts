import { getDb } from '@/app/lib/db/db';
import { enforcePublicApiRateLimit } from '@/app/lib/public-api-rate-limit.server';
import { boardDifficultyGrades } from '@/app/lib/db/schema';
import { eq, and, asc } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest, { params }: { params: Promise<{ board_name: string }> }) {
  const rateLimitedResponse = await enforcePublicApiRateLimit(request);
  if (rateLimitedResponse) return rateLimitedResponse;

  try {
    const { board_name } = await params;
    const db = getDb();

    const grades = await db
      .select({
        difficulty_id: boardDifficultyGrades.difficulty,
        difficulty_name: boardDifficultyGrades.boulderName,
      })
      .from(boardDifficultyGrades)
      .where(and(eq(boardDifficultyGrades.boardType, board_name), eq(boardDifficultyGrades.isListed, true)))
      .orderBy(asc(boardDifficultyGrades.difficulty));

    return NextResponse.json(grades, {
      headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800' },
    });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch grades' }, { status: 500 });
  }
}
