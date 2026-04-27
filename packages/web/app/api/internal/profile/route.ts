import { getServerSession } from "next-auth/next";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db/db";
import * as schema from "@/app/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { authOptions } from "@/app/lib/auth/auth-options";

const updateProfileSchema = z.object({
  displayName: z.string().max(100, "Display name must be less than 100 characters").optional().nullable(),
  avatarUrl: z.string().url("Invalid avatar URL").optional().nullable(),
  instagramUrl: z.string().url("Invalid Instagram URL").optional().nullable(),
  isPrivate: z.boolean().optional(),
});

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = getDb();

    // Run all queries in parallel since they are independent
    const [profiles, users, credentials, linkedAccounts] = await Promise.all([
      db
        .select()
        .from(schema.userProfiles)
        .where(eq(schema.userProfiles.userId, session.user.id))
        .limit(1),
      db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, session.user.id))
        .limit(1),
      db
        .select({ userId: schema.userCredentials.userId })
        .from(schema.userCredentials)
        .where(eq(schema.userCredentials.userId, session.user.id))
        .limit(1),
      db
        .select({ provider: schema.accounts.provider })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, session.user.id)),
    ]);

    if (users.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const user = users[0];
    const profile = profiles.length > 0 ? profiles[0] : null;

    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      hasPassword: credentials.length > 0,
      linkedProviders: linkedAccounts.map((a) => a.provider),
      isPrivate: profile?.isPrivate ?? false,
      profile: profile
        ? {
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            instagramUrl: profile.instagramUrl,
          }
        : null,
    });
  } catch (error) {
    console.error("Failed to get profile:", error);
    return NextResponse.json({ error: "Failed to get profile" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();

    // Validate input
    const validationResult = updateProfileSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: validationResult.error.issues[0].message },
        { status: 400 }
      );
    }

    const { displayName, avatarUrl, instagramUrl, isPrivate } = validationResult.data;
    const db = getDb();

    // Check if profile exists
    const existingProfile = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, session.user.id))
      .limit(1);

    const now = new Date();

    if (existingProfile.length > 0) {
      // Update existing profile
      const updateFields: Record<string, unknown> = {
        displayName: displayName ?? null,
        avatarUrl: avatarUrl ?? null,
        instagramUrl: instagramUrl ?? null,
        updatedAt: now,
      };
      if (isPrivate !== undefined) {
        updateFields.isPrivate = isPrivate;
      }
      await db
        .update(schema.userProfiles)
        .set(updateFields)
        .where(eq(schema.userProfiles.userId, session.user.id));
    } else {
      // Create new profile
      await db.insert(schema.userProfiles).values({
        userId: session.user.id,
        displayName: displayName ?? null,
        avatarUrl: avatarUrl ?? null,
        instagramUrl: instagramUrl ?? null,
        isPrivate: isPrivate ?? false,
      });
    }

    // Also update the user's name if displayName is provided
    if (displayName !== undefined) {
      await db
        .update(schema.users)
        .set({
          name: displayName || null,
          updatedAt: now,
        })
        .where(eq(schema.users.id, session.user.id));
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to update profile:", error);
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }
}
