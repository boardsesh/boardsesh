import { getServerSession } from 'next-auth/next';
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { authOptions } from '@/app/lib/auth/auth-options';

const favoriteSchema = z
  .object({
    climbUuid: z.string().min(1),
  })
  .strict();

const checkFavoriteSchema = z
  .object({
    // Cap matches packages/backend/src/validation/schemas/favorites.ts so a
    // caller can't trigger an unbounded inArray() query against the DB.
    climbUuids: z.array(z.string().min(1)).min(1).max(500),
  })
  .strict();

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
    const where = and(eq(schema.userFavorites.userId, session.user.id), eq(schema.userFavorites.climbUuid, climbUuid));

    const existing = await db.select().from(schema.userFavorites).where(where).limit(1);

    if (existing.length > 0) {
      await db.delete(schema.userFavorites).where(where);
      return NextResponse.json({ favorited: false });
    }

    await db.insert(schema.userFavorites).values({
      userId: session.user.id,
      climbUuid,
    });
    return NextResponse.json({ favorited: true });
  } catch (error) {
    console.error('Failed to toggle favorite:', error);
    return NextResponse.json({ error: 'Failed to toggle favorite' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
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

    const favorites = await db
      .select({ climbUuid: schema.userFavorites.climbUuid })
      .from(schema.userFavorites)
      .where(
        and(
          eq(schema.userFavorites.userId, session.user.id),
          inArray(schema.userFavorites.climbUuid, validationResult.data.climbUuids),
        ),
      );

    return NextResponse.json({ favorites: favorites.map((f) => f.climbUuid) });
  } catch (error) {
    console.error('Failed to check favorites:', error);
    return NextResponse.json({ error: 'Failed to check favorites' }, { status: 500 });
  }
}
