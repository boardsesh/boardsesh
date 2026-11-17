/**
 * `FEATURE_FLAG_OVERRIDES`: the environment variable that answers a server
 * flag without asking PostHog. www reads it in front of every server flag
 * (`packages/web/app/lib/feature-flags/server-feature-flag.ts`); the backend
 * reads it for `developer-console` outside production only
 * (`packages/backend/src/auth/partner/developer-access.ts`). One parser, so the
 * same line in an env file means the same thing to both.
 */
export const FEATURE_FLAG_OVERRIDES_ENV = 'FEATURE_FLAG_OVERRIDES';

const TRUTHY_OVERRIDE_VALUES = new Set(['1', 'true', 'on', 'yes']);
const FALSY_OVERRIDE_VALUES = new Set(['0', 'false', 'off', 'no']);

/**
 * Parse `FEATURE_FLAG_OVERRIDES` into a key -> boolean map.
 *
 * Two forms, comma separated:
 *   `some-flag`        — bare key, forces ON
 *   `some-flag=false`  — explicit value, forces ON or OFF
 *
 * An explicit OFF matters as much as an ON: it is how you check the 404 branch
 * without editing the PostHog dashboard. Entries that parse to neither are
 * ignored rather than throwing — a typo in a dev env var should not take the
 * whole page down.
 */
export function parseFeatureFlagOverrides(raw: string | undefined): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  if (!raw) {
    return overrides;
  }

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      overrides[trimmed] = true;
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if (!key) continue;
    if (TRUTHY_OVERRIDE_VALUES.has(value)) {
      overrides[key] = true;
    } else if (FALSY_OVERRIDE_VALUES.has(value)) {
      overrides[key] = false;
    }
  }

  return overrides;
}
