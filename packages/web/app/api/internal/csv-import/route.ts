import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/lib/auth/auth-options";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db/db";
import { boardseshTicks, boardClimbs } from "@/app/lib/db/schema";
import { eq, and, ilike } from "drizzle-orm";
import { randomUUID } from "crypto";
import { buildInferredSessionsForUser } from "@/app/lib/data-sync/aurora/inferred-session-builder";

const BOULDER_GRADES = [
  { difficulty_id: 10, font_grade: "4a", v_grade: "V0" },
  { difficulty_id: 11, font_grade: "4b", v_grade: "V0" },
  { difficulty_id: 12, font_grade: "4c", v_grade: "V0" },
  { difficulty_id: 13, font_grade: "5a", v_grade: "V1" },
  { difficulty_id: 14, font_grade: "5b", v_grade: "V1" },
  { difficulty_id: 15, font_grade: "5c", v_grade: "V2" },
  { difficulty_id: 16, font_grade: "6a", v_grade: "V3" },
  { difficulty_id: 17, font_grade: "6a+", v_grade: "V3" },
  { difficulty_id: 18, font_grade: "6b", v_grade: "V4" },
  { difficulty_id: 19, font_grade: "6b+", v_grade: "V4" },
  { difficulty_id: 20, font_grade: "6c", v_grade: "V5" },
  { difficulty_id: 21, font_grade: "6c+", v_grade: "V5" },
  { difficulty_id: 22, font_grade: "7a", v_grade: "V6" },
  { difficulty_id: 23, font_grade: "7a+", v_grade: "V7" },
  { difficulty_id: 24, font_grade: "7b", v_grade: "V8" },
  { difficulty_id: 25, font_grade: "7b+", v_grade: "V8" },
  { difficulty_id: 26, font_grade: "7c", v_grade: "V9" },
  { difficulty_id: 27, font_grade: "7c+", v_grade: "V10" },
  { difficulty_id: 28, font_grade: "8a", v_grade: "V11" },
  { difficulty_id: 29, font_grade: "8a+", v_grade: "V12" },
  { difficulty_id: 30, font_grade: "8b", v_grade: "V13" },
  { difficulty_id: 31, font_grade: "8b+", v_grade: "V14" },
  { difficulty_id: 32, font_grade: "8c", v_grade: "V15" },
  { difficulty_id: 33, font_grade: "8c+", v_grade: "V16" },
];

interface CsvRow {
  board: string;
  angle: number;
  climb_name: string;
  date: string;
  logged_grade?: string;
  displayed_grade?: string;
  is_benchmark?: boolean;
  tries?: number;
  is_mirror?: boolean;
  is_ascent?: boolean;
  comment?: string;
  climb_uuid?: string;
}

function mapGradeToDifficulty(grade: string | undefined): number | null {
  if (!grade) return null;

  const normalized = grade.trim().toLowerCase();

  // Handle combined format like "6c/V5" - try both parts
  const parts = normalized.split("/");
  for (const part of parts) {
    const trimmed = part.trim();

    // Check V-grade match
    const vMatch = BOULDER_GRADES.find(
      (g) => g.v_grade.toLowerCase() === trimmed,
    );
    if (vMatch) return vMatch.difficulty_id;

    // Check font grade match
    const fontMatch = BOULDER_GRADES.find(
      (g) => g.font_grade.toLowerCase() === trimmed,
    );
    if (fontMatch) return fontMatch.difficulty_id;
  }

  return null;
}

function determineStatus(row: CsvRow): "flash" | "send" | "attempt" {
  if (!row.is_ascent) return "attempt";
  if (row.tries === 1) return "flash";
  return "send";
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { boardType, rows } = body as {
      boardType: string;
      rows: CsvRow[];
    };

    if (!boardType || !["kilter", "tension"].includes(boardType)) {
      return NextResponse.json(
        { error: "Invalid boardType. Must be 'kilter' or 'tension'." },
        { status: 400 },
      );
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { error: "No rows provided." },
        { status: 400 },
      );
    }

    const db = getDb();
    const userId = session.user.id;
    const now = new Date().toISOString();

    let imported = 0;
    let skipped = 0;
    let duplicates = 0;
    const errors: string[] = [];

    // Process in batches of 100
    const BATCH_SIZE = 100;
    for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
      const batch = rows.slice(batchStart, batchStart + BATCH_SIZE);

      for (let i = 0; i < batch.length; i++) {
        const row = batch[i];
        const rowIndex = batchStart + i + 1; // 1-based for error messages

        try {
          // Resolve climb UUID
          let resolvedClimbUuid = row.climb_uuid || null;

          if (!resolvedClimbUuid && row.climb_name) {
            // Look up by name
            const matches = await db
              .select({ uuid: boardClimbs.uuid })
              .from(boardClimbs)
              .where(
                and(
                  eq(boardClimbs.boardType, boardType),
                  ilike(boardClimbs.name, row.climb_name),
                ),
              )
              .limit(1);

            if (matches.length > 0) {
              resolvedClimbUuid = matches[0].uuid;
            }
          }

          if (!resolvedClimbUuid) {
            skipped++;
            errors.push(
              `Row ${rowIndex}: Could not find climb '${row.climb_name || "unknown"}'`,
            );
            continue;
          }

          // Parse climbedAt
          const climbedAt = new Date(row.date);
          if (isNaN(climbedAt.getTime())) {
            skipped++;
            errors.push(`Row ${rowIndex}: Invalid date '${row.date}'`);
            continue;
          }
          const climbedAtStr = climbedAt.toISOString();

          // Deduplicate: check if tick already exists for this user + climbUuid + angle + climbedAt
          const existing = await db
            .select({ id: boardseshTicks.id })
            .from(boardseshTicks)
            .where(
              and(
                eq(boardseshTicks.userId, userId),
                eq(boardseshTicks.climbUuid, resolvedClimbUuid),
                eq(boardseshTicks.angle, row.angle),
                eq(boardseshTicks.climbedAt, climbedAtStr),
              ),
            )
            .limit(1);

          if (existing.length > 0) {
            duplicates++;
            continue;
          }

          // Insert tick
          await db.insert(boardseshTicks).values({
            uuid: randomUUID(),
            userId,
            boardType,
            climbUuid: resolvedClimbUuid,
            angle: row.angle,
            isMirror: row.is_mirror || false,
            status: determineStatus(row),
            attemptCount: row.tries || 1,
            quality: null,
            difficulty: mapGradeToDifficulty(
              row.logged_grade || row.displayed_grade,
            ),
            isBenchmark: row.is_benchmark || false,
            comment: row.comment || "",
            climbedAt: climbedAtStr,
            createdAt: now,
            updatedAt: now,
            auroraType: null,
            auroraId: null,
            auroraSyncedAt: null,
            auroraSyncError: null,
          });

          imported++;
        } catch (rowError) {
          skipped++;
          errors.push(
            `Row ${rowIndex}: ${rowError instanceof Error ? rowError.message : "Unknown error"}`,
          );
        }
      }
    }

    // Build inferred sessions after import
    if (imported > 0) {
      await buildInferredSessionsForUser(userId);
    }

    return NextResponse.json({
      imported,
      skipped,
      duplicates,
      errors,
    });
  } catch (error) {
    console.error("CSV import error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 },
    );
  }
}
