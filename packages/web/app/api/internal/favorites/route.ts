import { getServerSession } from 'next-auth/next';
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { authOptions } from '@/app/lib/auth/auth-options';

// Favorites are keyed by (user_id, climb_uuid). `boardName`/`angle` are still
// accepted from clients running older JS, and ignored.
const favoriteSchema = z.object({
  boardName: z.string().optional(),
  climbUuid: z.string().min(1),
  angle: z.number().int().optional(),
});

const checkFavoriteSchema = z.object({
  boardName: z.string().optional(),
  climbUuids: z.array(z.string().min(1)),
  angle: z.number().int().optional(),
});

// POST: Toggle favorite (add or remove)
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const validationResult = favoriteSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json({ error: validationResult.error.issues[0].message }, { status: 400 });
    }

    const { climbUuid } = validationResult.data;
    const db = getDb();

    // Check if favorite already exists
    const existing = await db
      .select()
      .from(schema.userFavorites)
      .where(and(eq(schema.userFavorites.userId, session.user.id), eq(schema.userFavorites.climbUuid, climbUuid)))
      .limit(1);

    if (existing.length > 0) {
      // Remove favorite
      await db
        .delete(schema.userFavorites)
        .where(and(eq(schema.userFavorites.userId, session.user.id), eq(schema.userFavorites.climbUuid, climbUuid)));
      return NextResponse.json({ favorited: false });
    } else {
      // Add favorite. onConflictDoNothing keeps two concurrent toggles from
      // raising a 23505 now that (user_id, climb_uuid) is unique — the loser of
      // the race sees the row already there, same as a plain re-favorite.
      await db
        .insert(schema.userFavorites)
        .values({
          userId: session.user.id,
          climbUuid,
        })
        .onConflictDoNothing({ target: [schema.userFavorites.userId, schema.userFavorites.climbUuid] });
      return NextResponse.json({ favorited: true });
    }
  } catch (error) {
    console.error('Failed to toggle favorite:', error);
    return NextResponse.json({ error: 'Failed to toggle favorite' }, { status: 500 });
  }
}

// GET: Check if climbs are favorited (batch check)
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      // Return empty favorites for non-authenticated users
      return NextResponse.json({ favorites: [] });
    }

    const { searchParams } = new URL(request.url);
    const climbUuidsParam = searchParams.get('climbUuids');

    if (!climbUuidsParam) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const climbUuids = climbUuidsParam.split(',');

    const validationResult = checkFavoriteSchema.safeParse({ climbUuids });

    if (!validationResult.success) {
      return NextResponse.json({ error: validationResult.error.issues[0].message }, { status: 400 });
    }

    const db = getDb();

    // Narrow to the requested climbs in SQL. Favorites carry no board or angle
    // any more, so the uuid list is the only filter left — without it this reads
    // every favorite the user has ever made on every board.
    const favorites = await db
      .select({ climbUuid: schema.userFavorites.climbUuid })
      .from(schema.userFavorites)
      .where(
        and(eq(schema.userFavorites.userId, session.user.id), inArray(schema.userFavorites.climbUuid, climbUuids)),
      );

    const favoritedUuids = favorites.map((favorite) => favorite.climbUuid);

    return NextResponse.json({ favorites: favoritedUuids });
  } catch (error) {
    console.error('Failed to check favorites:', error);
    return NextResponse.json({ error: 'Failed to check favorites' }, { status: 500 });
  }
}
