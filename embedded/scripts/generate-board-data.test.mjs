#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Tests for the board data code generator.
 *
 * Validates that the generated files are correct by:
 * 1. Running the generator
 * 2. Checking all output files exist and have expected content
 * 3. Verifying JPEG magic bytes in image data
 * 4. Verifying hold coordinate sanity
 * 5. Verifying config key format and lookup table completeness
 *
 * Output structure:
 *   board_image_data.h  - PROGMEM JPEG arrays (header, included by board_data.cpp)
 *   board_hold_data.h   - Struct definitions + extern declarations (header)
 *   board_data.cpp       - Hold arrays, BOARD_CONFIGS, findBoardConfig (implementation)
 *
 * Usage:
 *   node --test embedded/scripts/generate-board-data.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.join(__dirname, '../libs/board-data/src');
const IMAGE_HEADER = path.join(OUTPUT_DIR, 'board_image_data.h');
const HOLD_HEADER = path.join(OUTPUT_DIR, 'board_hold_data.h');
const DATA_CPP = path.join(OUTPUT_DIR, 'board_data.cpp');

describe('generate-board-data', () => {
  let imageContent;
  let holdContent;
  let dataCppContent;

  before(() => {
    // Run the generator
    console.log('Running board data generator...');
    execSync('node embedded/scripts/generate-board-data.mjs', {
      cwd: path.join(__dirname, '../..'),
      timeout: 300000,
      stdio: 'pipe',
    });

    imageContent = fs.readFileSync(IMAGE_HEADER, 'utf-8');
    holdContent = fs.readFileSync(HOLD_HEADER, 'utf-8');
    dataCppContent = fs.readFileSync(DATA_CPP, 'utf-8');
  });

  describe('output files', () => {
    it('should create board_image_data.h', () => {
      assert.ok(fs.existsSync(IMAGE_HEADER), 'board_image_data.h should exist');
    });

    it('should create board_hold_data.h', () => {
      assert.ok(fs.existsSync(HOLD_HEADER), 'board_hold_data.h should exist');
    });

    it('should create board_data.cpp', () => {
      assert.ok(fs.existsSync(DATA_CPP), 'board_data.cpp should exist');
    });

    it('should have #pragma once in image header', () => {
      assert.ok(imageContent.includes('#pragma once'), 'image header should have pragma once');
    });

    it('should have #pragma once in hold header', () => {
      assert.ok(holdContent.includes('#pragma once'), 'hold header should have pragma once');
    });

    it('board_data.cpp should include both headers', () => {
      assert.ok(
        dataCppContent.includes('#include "board_image_data.h"'),
        'board_data.cpp should include board_image_data.h',
      );
      assert.ok(
        dataCppContent.includes('#include "board_hold_data.h"'),
        'board_data.cpp should include board_hold_data.h',
      );
    });
  });

  describe('hold header (types only)', () => {
    it('should define HoldMapEntry struct', () => {
      assert.ok(holdContent.includes('struct HoldMapEntry'), 'should define HoldMapEntry');
    });

    it('should define BoardConfig struct', () => {
      assert.ok(holdContent.includes('struct BoardConfig'), 'should define BoardConfig');
    });

    it('should declare findBoardConfig function', () => {
      assert.ok(holdContent.includes('findBoardConfig'), 'should declare findBoardConfig');
    });

    it('should declare extern BOARD_CONFIGS and BOARD_CONFIG_COUNT', () => {
      assert.ok(
        holdContent.includes('extern const BoardConfig BOARD_CONFIGS[]'),
        'should declare extern BOARD_CONFIGS',
      );
      assert.ok(
        holdContent.includes('extern const int BOARD_CONFIG_COUNT'),
        'should declare extern BOARD_CONFIG_COUNT',
      );
    });

    it('should NOT contain data arrays (those belong in board_data.cpp)', () => {
      assert.ok(!holdContent.includes('PROGMEM'), 'hold header should not contain PROGMEM data');
      assert.ok(!holdContent.includes('holds_kilter_'), 'hold header should not contain hold arrays');
    });
  });

  describe('image data', () => {
    it('should contain JPEG magic bytes (0xff, 0xd8) for each image', () => {
      // Count image arrays
      const imageArrays = imageContent.match(/static const uint8_t image_\w+\[\]/g) || [];
      assert.ok(imageArrays.length > 0, 'should have at least one image array');

      // Each should start with 0xff, 0xd8 (JPEG SOI marker)
      const jpegStarts = imageContent.match(/\{\s*\n\s*0xff,\s*0xd8/g) || [];
      assert.equal(
        jpegStarts.length,
        imageArrays.length,
        `all ${imageArrays.length} images should start with JPEG magic bytes, found ${jpegStarts.length}`,
      );
    });

    it('should contain at least 30 board configurations', () => {
      const imageArrays = imageContent.match(/static const uint8_t image_\w+\[\]/g) || [];
      assert.ok(imageArrays.length >= 30, `expected >= 30 images, got ${imageArrays.length}`);
    });

    it('should include both kilter and tension boards', () => {
      assert.ok(imageContent.includes('image_kilter_'), 'should contain kilter images');
      assert.ok(imageContent.includes('image_tension_'), 'should contain tension images');
    });
  });

  describe('board_data.cpp (implementation)', () => {
    it('should have BOARD_CONFIG_COUNT matching number of configs', () => {
      const countMatch = dataCppContent.match(/BOARD_CONFIG_COUNT = (\d+)/);
      assert.ok(countMatch, 'should define BOARD_CONFIG_COUNT');
      const count = parseInt(countMatch[1]);
      assert.ok(count >= 30, `expected >= 30 configs, got ${count}`);

      // Count entries in BOARD_CONFIGS array
      const tableSection = dataCppContent.split('BOARD_CONFIGS[]')[1]?.split('BOARD_CONFIG_COUNT')[0] || '';
      const entries = tableSection.match(/\{"(?:kilter|tension)\/\d+\/\d+\/[\d,]+"/g) || [];
      assert.equal(
        entries.length,
        count,
        `BOARD_CONFIG_COUNT (${count}) should match number of entries (${entries.length})`,
      );
    });

    it('should have valid config key format in lookup table', () => {
      const configKeys = dataCppContent.match(/"((?:kilter|tension)\/\d+\/\d+\/[\d,]+)"/g) || [];
      for (const key of configKeys) {
        const cleaned = key.replace(/"/g, '');
        const parts = cleaned.split('/');
        assert.ok(parts.length === 4, `config key "${cleaned}" should have 4 parts`);
        assert.ok(['kilter', 'tension'].includes(parts[0]), `board name "${parts[0]}" should be kilter or tension`);
        assert.ok(/^\d+$/.test(parts[1]), `layout_id "${parts[1]}" should be numeric`);
        assert.ok(/^\d+$/.test(parts[2]), `size_id "${parts[2]}" should be numeric`);
        assert.ok(/^[\d,]+$/.test(parts[3]), `set_ids "${parts[3]}" should be comma-separated numbers`);
      }
    });

    it('should have hold entries with coordinates within image bounds', () => {
      // Parse a few hold entries and verify coordinates are reasonable
      const holdEntries = dataCppContent.match(/\{(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\}/g) || [];
      assert.ok(holdEntries.length > 100, `should have many hold entries, got ${holdEntries.length}`);

      let outOfBounds = 0;
      for (const entry of holdEntries.slice(0, 1000)) {
        const match = entry.match(/\{(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\}/);
        if (match) {
          const cx = parseInt(match[2]);
          const cy = parseInt(match[3]);
          const r = parseInt(match[4]);
          // Coordinates should be within reasonable bounds for 400x560 images
          if (cx > 500 || cy > 600 || r > 50 || r < 1) {
            outOfBounds++;
          }
        }
      }
      assert.ok(
        outOfBounds < holdEntries.length * 0.05,
        `too many out-of-bounds coordinates: ${outOfBounds}/${Math.min(holdEntries.length, 1000)}`,
      );
    });

    it('should implement findBoardConfig function', () => {
      assert.ok(
        dataCppContent.includes('const BoardConfig* findBoardConfig(const char* configKey)'),
        'should implement findBoardConfig',
      );
      assert.ok(
        dataCppContent.includes('strcmp(BOARD_CONFIGS[i].configKey, configKey)'),
        'findBoardConfig should use strcmp for lookup',
      );
    });
  });

  describe('specific configurations', () => {
    it('should include kilter/1/7/1,20 (most common Kilter board)', () => {
      assert.ok(dataCppContent.includes('"kilter/1/7/1,20"'), 'should include standard Kilter 12x14 config');
    });

    it('should include tension/9/1/8,9,10,11 (standard Tension board)', () => {
      assert.ok(dataCppContent.includes('"tension/9/1/8,9,10,11"'), 'should include standard Tension full wall config');
    });

    it('should include kilter/8/17/26,27 (Kilter homewall)', () => {
      assert.ok(dataCppContent.includes('"kilter/8/17/26,27"'), 'should include Kilter homewall config');
    });

    it('should have non-empty hold maps for common boards', () => {
      // kilter/1/7/1,20 should have lots of holds
      const match = dataCppContent.match(/"kilter\/1\/7\/1,20"[^}]+holds_kilter_1_7_1_20,\s*(\d+)/);
      assert.ok(match, 'should find kilter/1/7/1,20 in lookup table');
      const holdCount = parseInt(match[1]);
      assert.ok(holdCount > 400, `kilter/1/7/1,20 should have > 400 holds, got ${holdCount}`);
    });
  });

  describe('set_ids sorting', () => {
    it('should have numerically sorted set_ids in config keys', () => {
      const configKeys = dataCppContent.match(/"((?:kilter|tension)\/\d+\/\d+\/[\d,]+)"/g) || [];
      for (const key of configKeys) {
        const cleaned = key.replace(/"/g, '');
        const setIds = cleaned.split('/')[3].split(',').map(Number);
        for (let i = 1; i < setIds.length; i++) {
          assert.ok(setIds[i] >= setIds[i - 1], `set_ids in "${cleaned}" should be sorted: ${setIds.join(',')}`);
        }
      }
    });
  });
});
