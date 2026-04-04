import { getServerSession } from "next-auth/next";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db/db";
import * as schema from "@/app/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { authOptions } from "@/app/lib/auth/auth-options";
import { encrypt, decrypt } from "@boardsesh/crypto";
import AuroraClimbingClient from "@/app/lib/api-wrappers/aurora-rest-client/aurora-rest-client";
import { AuroraBoardName } from "@/app/lib/api-wrappers/aurora/types";

const saveCredentialsSchema = z.object({
  boardType: z.enum(["kilter", "tension"]),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

const deleteCredentialsSchema = z.object({
  boardType: z.enum(["kilter", "tension"]),
});

export interface AuroraCredentialStatus {
  boardType: string;
  auroraUsername: string;
  auroraUserId: number | null;
  lastSyncAt: string | null;
  syncStatus: string;
  syncError: string | null;
  createdAt: string;
}

/**
 * GET - Get all Aurora credentials status for the logged-in user
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = getDb();

    const credentials = await db
      .select()
      .from(schema.auroraCredentials)
      .where(eq(schema.auroraCredentials.userId, session.user.id));

    // Return credentials without sensitive data
    const credentialStatuses: AuroraCredentialStatus[] = credentials.map((cred) => {
      let username: string;
      try {
        username = decrypt(cred.encryptedUsername);
      } catch (decryptError) {
        console.error(`Failed to decrypt username for ${cred.boardType} credential:`, decryptError);
        username = '[Decryption Failed]';
      }

      return {
        boardType: cred.boardType,
        auroraUsername: username,
        auroraUserId: cred.auroraUserId,
        lastSyncAt: cred.lastSyncAt?.toISOString() ?? null,
        syncStatus: cred.syncStatus,
        syncError: cred.syncError,
        createdAt: cred.createdAt.toISOString(),
      };
    });

    return NextResponse.json({ credentials: credentialStatuses });
  } catch (error) {
    console.error("Failed to get Aurora credentials:", error);
    return NextResponse.json({ error: "Failed to get credentials" }, { status: 500 });
  }
}

/**
 * POST - Save Aurora credentials (login and store encrypted)
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();

    const validationResult = saveCredentialsSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: validationResult.error.issues[0].message },
        { status: 400 }
      );
    }

    const { boardType, username, password } = validationResult.data;

    // First, verify credentials by attempting login
    const auroraClient = new AuroraClimbingClient({ boardName: boardType as AuroraBoardName });
    let loginResponse;
    try {
      loginResponse = await auroraClient.signIn(username, password);
    } catch (error) {
      if (error instanceof Error && error.message.includes("401")) {
        return NextResponse.json({ error: "Invalid Aurora credentials" }, { status: 401 });
      }
      throw error;
    }

    if (!loginResponse.token || !loginResponse.user_id) {
      return NextResponse.json({ error: "Invalid login response from Aurora" }, { status: 400 });
    }

    const db = getDb();
    const now = new Date();

    // Encrypt credentials
    const encryptedUsername = encrypt(username);
    const encryptedPassword = encrypt(password);
    const encryptedToken = encrypt(loginResponse.token);

    // Check if credentials already exist
    const existing = await db
      .select()
      .from(schema.auroraCredentials)
      .where(
        and(
          eq(schema.auroraCredentials.userId, session.user.id),
          eq(schema.auroraCredentials.boardType, boardType)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      // Update existing credentials
      await db
        .update(schema.auroraCredentials)
        .set({
          encryptedUsername,
          encryptedPassword,
          auroraUserId: loginResponse.user_id,
          auroraToken: encryptedToken,
          lastSyncAt: null,
          syncStatus: "pending",
          syncError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.auroraCredentials.userId, session.user.id),
            eq(schema.auroraCredentials.boardType, boardType)
          )
        );
    } else {
      // Insert new credentials
      await db.insert(schema.auroraCredentials).values({
        userId: session.user.id,
        boardType,
        encryptedUsername,
        encryptedPassword,
        auroraUserId: loginResponse.user_id,
        auroraToken: encryptedToken,
        lastSyncAt: null,
        syncStatus: "pending",
        syncError: null,
      });
    }

    // Also update/create user board mapping
    const existingMapping = await db
      .select()
      .from(schema.userBoardMappings)
      .where(
        and(
          eq(schema.userBoardMappings.userId, session.user.id),
          eq(schema.userBoardMappings.boardType, boardType)
        )
      )
      .limit(1);

    if (existingMapping.length > 0) {
      await db
        .update(schema.userBoardMappings)
        .set({
          boardUserId: loginResponse.user_id,
          boardUsername: username,
          linkedAt: now,
        })
        .where(
          and(
            eq(schema.userBoardMappings.userId, session.user.id),
            eq(schema.userBoardMappings.boardType, boardType)
          )
        );
    } else {
      await db.insert(schema.userBoardMappings).values({
        userId: session.user.id,
        boardType,
        boardUserId: loginResponse.user_id,
        boardUsername: username,
      });
    }

    return NextResponse.json({
      success: true,
      credential: {
        boardType,
        auroraUsername: username,
        auroraUserId: loginResponse.user_id,
        lastSyncAt: null,
        syncStatus: "pending",
        syncError: null,
        createdAt: now.toISOString(),
      },
    });
  } catch (error) {
    console.error("Failed to save Aurora credentials:", error);
    return NextResponse.json({ error: "Failed to save credentials" }, { status: 500 });
  }
}

/**
 * DELETE - Remove Aurora credentials for a specific board
 */
export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();

    const validationResult = deleteCredentialsSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: validationResult.error.issues[0].message },
        { status: 400 }
      );
    }

    const { boardType } = validationResult.data;
    const db = getDb();

    // Delete credentials
    await db
      .delete(schema.auroraCredentials)
      .where(
        and(
          eq(schema.auroraCredentials.userId, session.user.id),
          eq(schema.auroraCredentials.boardType, boardType)
        )
      );

    // Also remove the board mapping
    await db
      .delete(schema.userBoardMappings)
      .where(
        and(
          eq(schema.userBoardMappings.userId, session.user.id),
          eq(schema.userBoardMappings.boardType, boardType)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete Aurora credentials:", error);
    return NextResponse.json({ error: "Failed to delete credentials" }, { status: 500 });
  }
}
