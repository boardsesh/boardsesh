import { flag, evaluate, combine } from 'flags/next';
import { vercelAdapter } from '@flags-sdk/vercel';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/app/lib/auth/auth-options';

// Only use the Vercel adapter when the FLAGS env var is available (set automatically
// on Vercel). Locally, flags fall through to their decide() functions.
const adapter = process.env.FLAGS ? vercelAdapter() : undefined;

async function identify() {
  const session = await getServerSession(authOptions);
  return session?.user ? { user: { id: session.user.id, email: session.user.email } } : {};
}

export const rustSvgRendering = flag({
  key: 'rust-svg-rendering',
  defaultValue: false,
  description: 'Use Rust WASM renderer for board overlays instead of SVG',
  identify,
  options: [
    { value: true, label: 'Enabled' },
    { value: false, label: 'Disabled' },
  ],
  // When the adapter is available, let it be the sole decision maker.
  // When no adapter (local dev), use decide() which falls back to defaultValue.
  ...(adapter
    ? { adapter }
    : { decide: () => false as boolean }),
});

export const disableSvgVirtualisation = flag({
  key: 'disable-svg-virtualisation',
  defaultValue: false,
  description: 'Disable list virtualisation when using SVG rendering (keeps SVG, skips windowing)',
  identify,
  options: [
    { value: true, label: 'Virtualisation Off' },
    { value: false, label: 'Virtualisation On' },
  ],
  ...(adapter
    ? { adapter }
    : { decide: () => false as boolean }),
});

// Add new flags above this line, then add them to allFlags below.
export const allFlags = [rustSvgRendering, disableSvgVirtualisation] as const;

type FlagTuple = typeof allFlags;
export type FeatureFlags = {
  [K in FlagTuple[number] as K['key']]: Awaited<ReturnType<K>>;
};

export async function evaluateAllFlags(): Promise<FeatureFlags> {
  const values = await evaluate(allFlags);
  return combine(allFlags, values) as FeatureFlags;
}
