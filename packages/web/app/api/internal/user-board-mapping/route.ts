import { getServerSession } from "next-auth/next";
import { NextRequest, NextResponse } from "next/server";
import { createUserBoardMapping, getUserBoardMappings } from "@/app/lib/auth/user-board-mappings";
import { authOptions } from "@/app/lib/auth/auth-options";
import { z } from "zod";
import { AURORA_BOARDS, type AuroraBoardName } from "@boardsesh/shared-schema";

const userBoardMappingSchema = z.object({
  boardType: z.enum([...AURORA_BOARDS] as [AuroraBoardName, ...AuroraBoardName[]], {
    message: `Board type must be one of ${AURORA_BOARDS.join(", ")}`,
  }),
  boardUserId: z.number().int().positive("Board user ID must be a positive integer"),
  boardUsername: z.string().max(100, "Username too long").optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const result = userBoardMappingSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json({ error: "Invalid request data" }, { status: 400 });
    }

    const { boardType, boardUserId, boardUsername } = result.data;

    await createUserBoardMapping(
      session.user.id,
      boardType,
      boardUserId,
      boardUsername
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to create board mapping:", error);
    return NextResponse.json(
      { error: "Failed to create board mapping" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const mappings = await getUserBoardMappings(session.user.id);
    return NextResponse.json({ mappings });
  } catch (error) {
    console.error("Failed to get board mappings:", error);
    return NextResponse.json(
      { error: "Failed to get board mappings" },
      { status: 500 }
    );
  }
}