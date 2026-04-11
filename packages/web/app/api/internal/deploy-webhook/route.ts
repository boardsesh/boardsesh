import { createHmac, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { AURORA_BOARD_NAMES } from '@/app/lib/board-constants';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const DEPLOY_WEBHOOK_SECRET = process.env.DEPLOY_WEBHOOK_SECRET;
const CRON_SECRET = process.env.CRON_SECRET;

type VercelWebhookPayload = {
  type: string;
  payload: {
    target?: string;
    [key: string]: unknown;
  };
};

function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha1', secret).update(rawBody).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!DEPLOY_WEBHOOK_SECRET) {
    console.error('[deploy-webhook] DEPLOY_WEBHOOK_SECRET is not set');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-vercel-signature');

  if (!verifySignature(rawBody, signature, DEPLOY_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let event: VercelWebhookPayload;
  try {
    event = JSON.parse(rawBody) as VercelWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Only act on successful production deployments; acknowledge all other events silently.
  if (event.type !== 'deployment.succeeded' || event.payload.target !== 'production') {
    return NextResponse.json({
      skipped: true,
      type: event.type,
      target: event.payload.target ?? null,
    });
  }

  if (!CRON_SECRET) {
    console.error('[deploy-webhook] CRON_SECRET is not set — cannot fan out to prewarm endpoints');
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  const baseUrl = process.env.APP_URL ?? `https://${process.env.VERCEL_URL}`;

  // Fire-and-forget — return immediately; the prewarm endpoints handle the heavy lifting
  // under their own maxDuration = 300 budget.
  for (const board of AURORA_BOARD_NAMES) {
    fetch(`${baseUrl}/api/internal/prewarm-heatmap/${board}`, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    }).catch((err: unknown) => {
      console.error(`[deploy-webhook] failed to trigger prewarm for ${board}:`, err);
    });
  }

  console.log(`[deploy-webhook] triggered prewarm for: ${AURORA_BOARD_NAMES.join(', ')}`);

  return NextResponse.json({ triggered: AURORA_BOARD_NAMES });
}
