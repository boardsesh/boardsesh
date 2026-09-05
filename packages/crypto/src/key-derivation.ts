// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import crypto from 'crypto';

/**
 * PBKDF2 key derivation parameters
 * These must remain constant for backward compatibility with existing encrypted data
 */
export const PBKDF2_ITERATIONS = 100000;
export const PBKDF2_SALT = 'aurora-credentials-salt';
export const KEY_LENGTH = 32; // 256 bits for AES-256

/**
 * Derive an AES-256 encryption key from a secret using PBKDF2
 * Uses a fixed salt for consistent key derivation across encrypt/decrypt operations
 */
export function deriveKey(secret: string): Buffer {
  return crypto.pbkdf2Sync(secret, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}
