// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Shared test utilities for validating parser results.
 */

import { expect } from 'vite-plus/test';
import type { ParseResult } from '../../types';
import type { ExpectedClimbResult } from '../fixtures/expected-results';

export type ValidationOptions = {
  /** Whether to validate OCR fields (name, setter, grades) */
  validateOcr: boolean;
  /** Use partial matching for name (toContain instead of toBe) */
  partialNameMatch: boolean;
};

/**
 * Validate a parse result against expected data.
 */
export function validateParseResult(
  result: ParseResult,
  expected: ExpectedClimbResult,
  options: ValidationOptions = { validateOcr: true, partialNameMatch: false },
): void {
  // Basic success checks
  expect(result.success).toBe(true);
  expect(result.climb).toBeDefined();

  const climb = result.climb!;

  // OCR validation (optional)
  if (options.validateOcr) {
    if (expected.name !== null) {
      if (options.partialNameMatch) {
        // For partial match, check key words are present (handles multi-line names)
        // Split on spaces but filter out small words and punctuation
        const keyWords = expected.name
          .split(/\s+/)
          .filter((w) => w.length > 2)
          .map((w) => w.replace(/[^A-Za-z0-9]/g, '')); // Remove punctuation

        for (const word of keyWords) {
          if (word.length > 0) {
            expect(climb.name.toUpperCase()).toContain(word.toUpperCase());
          }
        }
      } else {
        expect(climb.name).toBe(expected.name);
      }
    }

    if (expected.setter !== null) {
      if (options.partialNameMatch) {
        // Check if setter contains the expected value or vice versa
        const setterMatch = climb.setter.includes(expected.setter) || expected.setter.includes(climb.setter);
        expect(setterMatch).toBe(true);
      } else {
        expect(climb.setter).toBe(expected.setter);
      }
    }

    expect(climb.angle).toBe(expected.angle);

    if (expected.userGrade !== null) {
      expect(climb.userGrade).toBe(expected.userGrade);
    }

    if (expected.setterGrade !== null) {
      expect(climb.setterGrade).toBe(expected.setterGrade);
    }

    expect(climb.isBenchmark).toBe(expected.isBenchmark);
  }

  // Hold validation (always required - this is the critical part)
  expect(climb.holds.start.sort()).toEqual([...expected.startHolds].sort());
  expect(climb.holds.hand.sort()).toEqual([...expected.handHolds].sort());
  expect(climb.holds.finish.sort()).toEqual([...expected.finishHolds].sort());
}
