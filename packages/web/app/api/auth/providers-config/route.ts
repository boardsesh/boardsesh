import { NextResponse } from 'next/server';

/**
 * Returns which OAuth providers are configured.
 * This allows the client to show/hide social login buttons appropriately.
 */
export async function GET() {
  return NextResponse.json({
    google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    apple: !!(process.env.APPLE_ID && process.env.APPLE_SECRET),
  });
}
