// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Environment configuration for encryption
 */

export const ENV_VAR_NAME = 'AURORA_CREDENTIALS_SECRET';
const DEFAULT_DEV_KEY = 'changeme-development-key';

/**
 * Get the encryption secret, with a development fallback.
 *
 * Keyed on NODE_ENV alone — the host-agnostic signal. `VERCEL_ENV === 'development'`
 * used to be OR'd in, but it is only ever set by the tracked
 * `packages/web/.env.local`, where NODE_ENV already says `development`, so it
 * added no case any host reaches (#4651).
 *
 * @throws Error if the secret is not set and this is not a dev run
 */
export function getEncryptionSecret(): string {
  const secret = process.env[ENV_VAR_NAME];

  if (secret) {
    return secret;
  }

  if (process.env.NODE_ENV === 'development') {
    return DEFAULT_DEV_KEY;
  }

  throw new Error(`${ENV_VAR_NAME} environment variable is not set`);
}
