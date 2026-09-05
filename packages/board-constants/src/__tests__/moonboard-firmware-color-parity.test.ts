// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOLD_STATE_MAP } from '../hold-states';

/**
 * The app and this repo's own ESP32 MoonBoard firmware must light a role the
 * same colour.
 *
 * MoonBoard's BLE wire format carries role LETTERS, not RGB, so nothing forces
 * the two to agree — `HOLD_STATE_MAP.moonboard[].color` is the app's mirror of
 * what the controller lights, kept in step by hand. That is exactly how it
 * drifted: FOOT was moved to amber in the app while
 * `embedded/libs/moonboard-protocol` still lit it cyan, which would have shown
 * a foot hold cyan on the wall and amber in the app.
 *
 * The firmware also feeds frames back — `p<id>r45` strings the app renders
 * through this same map — so the two really are two ends of one contract.
 *
 * Parsed out of the C++ rather than duplicated as a list: a hardcoded copy of
 * the firmware's palette here would drift from the firmware just as silently as
 * the app did.
 */

const FIRMWARE_SOURCE = join(
  import.meta.dirname,
  '../../../../embedded/libs/moonboard-protocol/src/moonboard_protocol.cpp',
);

/** `constexpr uint8_t COLOR_NAME[3] = {r, g, b};` → `{ COLOR_NAME: '#rrggbb' }`. */
function firmwarePalette(source: string): Record<string, string> {
  const palette: Record<string, string> = {};
  const declaration = /constexpr uint8_t (COLOR_[A-Z]+)\[3\] = \{\s*(\d+),\s*(\d+),\s*(\d+)\s*\};/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    const [, name, ...channels] = match;
    palette[name] = `#${channels.map((value) => Number(value).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  }
  return palette;
}

/** The `case 'X': color = COLOR_NAME;` arms of `tokenToColor`, as token → colour. */
function firmwareTokenColors(source: string, palette: Record<string, string>): Record<string, string> {
  const body = source.slice(source.indexOf('void MoonBoardProtocol::tokenToColor'));
  const arms = body.slice(0, body.indexOf('\n}'));
  const colors: Record<string, string> = {};
  const arm = /case '([A-Z])':\s*case '[a-z]':\s*color = (COLOR_[A-Z]+);/g;
  let match: RegExpExecArray | null;
  while ((match = arm.exec(arms)) !== null) {
    const [, token, colorName] = match;
    colors[token] = palette[colorName];
  }
  return colors;
}

/**
 * Firmware token → the MoonBoard role code it decodes to, from
 * `tokenToRoleCode` in the same file. `P`/`R` both mean HAND; the colour switch
 * only names the non-default tokens, since HAND is the `default:` arm.
 */
const TOKEN_TO_ROLE: [token: string, roleCode: number, role: string][] = [
  ['S', 42, 'STARTING'],
  ['F', 45, 'FOOT'],
  ['E', 44, 'FINISH'],
];

describe('MoonBoard firmware colour parity', () => {
  const source = readFileSync(FIRMWARE_SOURCE, 'utf8');
  const palette = firmwarePalette(source);
  const tokenColors = firmwareTokenColors(source, palette);

  it('parses the firmware palette (guards the parser itself, not the colours)', () => {
    // If the firmware is refactored so these regexes stop matching, every
    // assertion below would vacuously pass. This is what makes them mean
    // something.
    expect(Object.keys(palette).length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(tokenColors).sort()).toEqual(['E', 'F', 'L', 'M', 'S']);
  });

  it('lights FOOT the amber the app draws, not the cyan it used to', () => {
    // The regression this file exists for. Cyan sat next to the blue HAND on an
    // RGB strip and was hard to call apart mid-climb.
    expect(tokenColors.F).toBe('#FFAA00');
    expect(HOLD_STATE_MAP.moonboard[45].color.toUpperCase()).toBe(tokenColors.F);
  });

  it.each(TOKEN_TO_ROLE)('agrees with the app on the %s token (role %i, %s)', (token, roleCode) => {
    expect(HOLD_STATE_MAP.moonboard[roleCode].color.toUpperCase()).toBe(tokenColors[token]);
  });

  it('agrees with the app on HAND, and HAND is still the firmware’s default arm', () => {
    // HAND is the `default:` case, so it has no `case 'X':` arm to parse. Assert
    // the arm itself as well as the constant — otherwise the firmware could
    // switch its default to another colour and this test would not notice.
    expect(source).toMatch(/default:\s*color = COLOR_BLUE;/);
    expect(palette.COLOR_BLUE).toBe('#0000FF');
    expect(HOLD_STATE_MAP.moonboard[43].color.toUpperCase()).toBe(palette.COLOR_BLUE);
  });

  /**
   * Roles 46-48 do NOT agree, and did not before this test existed.
   *
   * Pinned as the divergence they are rather than left silent: the app draws
   * screen-tuned values while the firmware lights raw LED primaries. Both sides
   * are frozen here, so changing either one fails this test and forces the
   * decision to be made deliberately instead of discovered on a wall.
   */
  it.each([
    ['AUX', 46, '#FFE066', 'COLOR_YELLOW', '#FFFF00'],
    ['LEFT hand', 47, '#8B5CF6', 'COLOR_VIOLET', '#8000FF'],
    ['MATCH hand', 48, '#FF4FA3', 'COLOR_PINK', '#FF00A0'],
  ])('records the known %s divergence (role %i)', (_role, roleCode, appColor, firmwareName, firmwareColor) => {
    expect(HOLD_STATE_MAP.moonboard[roleCode].color.toUpperCase()).toBe(appColor);
    expect(palette[firmwareName]).toBe(firmwareColor);
    expect(appColor).not.toBe(firmwareColor);
  });
});
