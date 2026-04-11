import { getServerSession } from "next-auth/next";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db/db";
import { esp32Controllers } from "@boardsesh/db/schema/app";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { authOptions } from "@/app/lib/auth/auth-options";
import { randomBytes } from "crypto";
import { AURORA_BOARDS, type AuroraBoardName } from "@boardsesh/shared-schema";

const registerControllerSchema = z.object({
  name: z.string().max(100).optional(),
  boardName: z.enum([...AURORA_BOARDS] as [AuroraBoardName, ...AuroraBoardName[]]),
  layoutId: z.number().int().positive(),
  sizeId: z.number().int().positive(),
  setIds: z.string().min(1),
});

const deleteControllerSchema = z.object({
  controllerId: z.string().uuid(),
});

export interface ControllerInfo {
  id: string;
  name: string | null;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  isOnline: boolean;
  lastSeen: string | null;
  createdAt: string;
}

// Consider controller online if seen within last 60 seconds
const ONLINE_THRESHOLD_MS = 60 * 1000;

/**
 * Generate a secure random API key
 */
function generateApiKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * GET - Get all ESP32 controllers registered by the logged-in user
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = getDb();

    const controllers = await db
      .select()
      .from(esp32Controllers)
      .where(eq(esp32Controllers.userId, session.user.id));

    const now = Date.now();

    const controllerList: ControllerInfo[] = controllers.map((controller) => ({
      id: controller.id,
      name: controller.name,
      boardName: controller.boardName,
      layoutId: controller.layoutId,
      sizeId: controller.sizeId,
      setIds: controller.setIds,
      isOnline: controller.lastSeenAt
        ? now - controller.lastSeenAt.getTime() < ONLINE_THRESHOLD_MS
        : false,
      lastSeen: controller.lastSeenAt?.toISOString() ?? null,
      createdAt: controller.createdAt.toISOString(),
    }));

    return NextResponse.json({ controllers: controllerList });
  } catch (error) {
    console.error("Failed to get controllers:", error);
    return NextResponse.json({ error: "Failed to get controllers" }, { status: 500 });
  }
}

/**
 * POST - Register a new ESP32 controller
 * Returns the API key ONCE - it cannot be retrieved again
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();

    const validationResult = registerControllerSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: validationResult.error.issues[0].message },
        { status: 400 }
      );
    }

    const { name, boardName, layoutId, sizeId, setIds } = validationResult.data;
    const apiKey = generateApiKey();

    const db = getDb();

    const [controller] = await db
      .insert(esp32Controllers)
      .values({
        userId: session.user.id,
        apiKey,
        name: name ?? null,
        boardName,
        layoutId,
        sizeId,
        setIds,
      })
      .returning();

    return NextResponse.json({
      success: true,
      controllerId: controller.id,
      apiKey, // Only returned on creation - save it now!
      controller: {
        id: controller.id,
        name: controller.name,
        boardName: controller.boardName,
        layoutId: controller.layoutId,
        sizeId: controller.sizeId,
        setIds: controller.setIds,
        isOnline: false,
        lastSeen: null,
        createdAt: controller.createdAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("Failed to register controller:", error);
    return NextResponse.json({ error: "Failed to register controller" }, { status: 500 });
  }
}

/**
 * DELETE - Remove an ESP32 controller
 */
export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();

    const validationResult = deleteControllerSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: validationResult.error.issues[0].message },
        { status: 400 }
      );
    }

    const { controllerId } = validationResult.data;
    const db = getDb();

    // Only delete if user owns the controller
    await db
      .delete(esp32Controllers)
      .where(
        and(
          eq(esp32Controllers.id, controllerId),
          eq(esp32Controllers.userId, session.user.id)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete controller:", error);
    return NextResponse.json({ error: "Failed to delete controller" }, { status: 500 });
  }
}
