import { CredentialAuthorityUnavailable } from '@/app/lib/auth/credential-admission.server';
import { unavailableCredentialResponse } from '@/app/lib/auth/credential-admission-response.server';
import { getAdmittedServerSession } from '@/app/lib/auth/admitted-session.server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { revalidateClimbSearchTags } from '@/app/lib/climb-search-cache.server';

// `layoutId` is still accepted — the client sends it (climb-search-cache.ts) —
// but nothing reads it: cache entries are tagged per board, so board-level
// invalidation already covers every layout.
const revalidateClimbSearchSchema = z.object({
  boardName: z.enum(['kilter', 'moonboard', 'tension', 'soill']),
  layoutId: z.number().int().positive().optional(),
});

export async function POST(request: Request) {
  try {
    const session = await getAdmittedServerSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const validated = revalidateClimbSearchSchema.parse(body);

    await revalidateClimbSearchTags({ boardName: validated.boardName });

    return NextResponse.json({ revalidated: true });
  } catch (error) {
    if (error instanceof CredentialAuthorityUnavailable) return unavailableCredentialResponse();
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request data', details: error.issues }, { status: 400 });
    }

    console.error('[Climb Search Cache] Revalidation failed:', error);
    return NextResponse.json({ error: 'Failed to revalidate climb search cache' }, { status: 500 });
  }
}
