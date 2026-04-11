import { getServerSession } from 'next-auth/next';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authOptions } from '@/app/lib/auth/auth-options';
import { auroraExportSchema, importJsonExportData } from '@/app/lib/data-sync/aurora/json-import';
import type { ImportResult, ImportProgressEvent } from '@/app/lib/data-sync/aurora/json-import';
import { AURORA_BOARDS, type AuroraBoardName } from '@boardsesh/shared-schema';

export const maxDuration = 300;

const requestSchema = z.object({
  boardType: z.enum([...AURORA_BOARDS] as [AuroraBoardName, ...AuroraBoardName[]]),
  data: auroraExportSchema,
  skipSessionBuild: z.boolean().optional().default(false),
});

export interface AuroraImportResponse {
  success: boolean;
  results: ImportResult;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { boardType, data, skipSessionBuild } = parsed.data;

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: ImportProgressEvent) => {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        };

        try {
          const results = await importJsonExportData(
            session.user!.id,
            boardType,
            data,
            send,
            { skipSessionBuild },
          );

          send({ type: 'complete', results });
        } catch (error) {
          console.error('Aurora JSON import error:', error);
          send({ type: 'error', error: error instanceof Error ? error.message : 'Import failed' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('Aurora JSON import error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Import failed' },
      { status: 500 },
    );
  }
}
