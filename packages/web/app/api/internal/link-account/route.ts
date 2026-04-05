import { getServerSession } from "next-auth/next";
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/app/lib/db/db";
import * as schema from "@/app/lib/db/schema";
import { eq, and, count } from "drizzle-orm";
import { z } from "zod";
import { authOptions } from "@/app/lib/auth/auth-options";
import {
  issueAccountLinkIntentToken,
  ACCOUNT_LINK_INTENT_COOKIE,
} from "@/app/lib/auth/account-link-intent";

const unlinkSchema = z.object({
  provider: z.enum(["google", "apple", "facebook"]),
});

/**
 * POST - Set an account-link-intent cookie so the next OAuth sign-in
 * links the provider to the current user instead of erroring.
 */
export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = issueAccountLinkIntentToken(session.user.id);
    const cookieStore = await cookies();
    cookieStore.set(ACCOUNT_LINK_INTENT_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 300, // 5 minutes
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to set link intent:", error);
    return NextResponse.json(
      { error: "Failed to initiate account linking" },
      { status: 500 },
    );
  }
}

/**
 * DELETE - Unlink an OAuth provider from the current user's account.
 * Refuses if it would leave the user with no sign-in method.
 */
export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const validation = unlinkSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid provider" },
        { status: 400 },
      );
    }

    const { provider } = validation.data;
    const userId = session.user.id;
    const db = getDb();

    // Check the provider is actually linked
    const linked = await db
      .select({ provider: schema.accounts.provider })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, userId),
          eq(schema.accounts.provider, provider),
        ),
      )
      .limit(1);

    if (linked.length === 0) {
      return NextResponse.json(
        { error: "Provider not linked" },
        { status: 404 },
      );
    }

    // Count remaining auth methods (other providers + password)
    const [providerCountResult, passwordResult] = await Promise.all([
      db
        .select({ total: count() })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, userId)),
      db
        .select({ userId: schema.userCredentials.userId })
        .from(schema.userCredentials)
        .where(eq(schema.userCredentials.userId, userId))
        .limit(1),
    ]);

    const totalProviders = providerCountResult[0]?.total ?? 0;
    const hasPassword = passwordResult.length > 0;
    const totalMethods = totalProviders + (hasPassword ? 1 : 0);

    if (totalMethods <= 1) {
      return NextResponse.json(
        {
          error:
            "Can't disconnect your only sign-in method. Set a password first or connect another provider.",
        },
        { status: 400 },
      );
    }

    // Remove the provider link
    await db
      .delete(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, userId),
          eq(schema.accounts.provider, provider),
        ),
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to unlink account:", error);
    return NextResponse.json(
      { error: "Failed to disconnect provider" },
      { status: 500 },
    );
  }
}
