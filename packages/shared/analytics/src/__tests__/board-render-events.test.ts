import { describe, it, expect } from 'vitest';
import { SHARED_EVENTS } from '../events';
import {
  boardPinch,
  boardRenderPresetApplied,
  boardRenderSettingsChanged,
  buildBoardRenderTelemetryProps,
  climbFirstAction,
  climbViewOpened,
  type BoardRenderContext,
  type BoardRenderEffectiveSettings,
} from '../board-render-events';

const EFFECTIVE_BOARDSESH: BoardRenderEffectiveSettings = {
  mode: 'boardsesh',
  glowFalloff: 'plateau',
  glowFalloffSource: 'flag',
};

const EFFECTIVE_CLASSIC: BoardRenderEffectiveSettings = {
  mode: 'classic',
  glowFalloff: 'soft',
  glowFalloffSource: 'default',
};

const CONTEXT: BoardRenderContext = { boardName: 'kilter', layoutId: 1, sizeId: 2 };

describe('buildBoardRenderTelemetryProps', () => {
  it('assembles the common props in snake_case', () => {
    expect(buildBoardRenderTelemetryProps(EFFECTIVE_BOARDSESH, CONTEXT)).toEqual({
      board_name: 'kilter',
      layout_id: 1,
      size_id: 2,
      render_mode: 'boardsesh',
      glow_falloff: 'plateau',
      glow_falloff_source: 'flag',
    });
  });

  it('omits preset_id and palette_id entirely when absent', () => {
    const props = buildBoardRenderTelemetryProps(EFFECTIVE_CLASSIC, CONTEXT);
    expect(Object.hasOwn(props, 'preset_id')).toBe(false);
    expect(Object.hasOwn(props, 'palette_id')).toBe(false);
  });

  it('carries preset_id and palette_id when the context has them', () => {
    const props = buildBoardRenderTelemetryProps(EFFECTIVE_BOARDSESH, {
      ...CONTEXT,
      presetId: 'high-contrast',
      paletteId: 'deuteranopia',
    });
    expect(props.preset_id).toBe('high-contrast');
    expect(props.palette_id).toBe('deuteranopia');
  });
});

describe('board-render event builders', () => {
  it('climbViewOpened pairs the name with the full common props plus its own fields', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_BOARDSESH, CONTEXT);
    expect(climbViewOpened({ ...commonProps, climb_uuid: 'climb-1', reopened_in_session: false })).toEqual({
      name: SHARED_EVENTS.ClimbViewOpened,
      properties: {
        board_name: 'kilter',
        layout_id: 1,
        size_id: 2,
        render_mode: 'boardsesh',
        glow_falloff: 'plateau',
        glow_falloff_source: 'flag',
        climb_uuid: 'climb-1',
        reopened_in_session: false,
      },
    });
  });

  it('boardPinch carries scale_max alongside the common props', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_CLASSIC, CONTEXT);
    expect(boardPinch({ ...commonProps, scale_max: 2.4 })).toEqual({
      name: SHARED_EVENTS.BoardPinch,
      properties: { ...commonProps, scale_max: 2.4 },
    });
  });

  it('climbFirstAction carries climb_uuid, action_type and ms_since_open', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_BOARDSESH, CONTEXT);
    expect(
      climbFirstAction({ ...commonProps, climb_uuid: 'climb-1', action_type: 'ble', ms_since_open: 4200 }),
    ).toEqual({
      name: SHARED_EVENTS.ClimbFirstAction,
      properties: { ...commonProps, climb_uuid: 'climb-1', action_type: 'ble', ms_since_open: 4200 },
    });
  });

  it('boardRenderSettingsChanged carries field and value', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_CLASSIC, CONTEXT);
    expect(boardRenderSettingsChanged({ ...commonProps, field: 'glowFalloff', value: 'plateau' })).toEqual({
      name: SHARED_EVENTS.BoardRenderSettingsChanged,
      properties: { ...commonProps, field: 'glowFalloff', value: 'plateau' },
    });
  });

  it('boardRenderPresetApplied is exactly the common props, preset_id included', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_BOARDSESH, {
      ...CONTEXT,
      presetId: 'high-contrast',
    });
    expect(boardRenderPresetApplied(commonProps)).toEqual({
      name: SHARED_EVENTS.BoardRenderPresetApplied,
      properties: commonProps,
    });
  });
});

describe('stratification guard', () => {
  // Every builder's properties must always carry board_name and
  // glow_falloff_source — the two dimensions docs/board-render-analytics.md
  // says a query must never pool across. A future builder that forgets to
  // spread the common props would silently produce an unstratifiable event.
  it('every payload above carries board_name and glow_falloff_source', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_BOARDSESH, CONTEXT);
    const payloads = [
      climbViewOpened({ ...commonProps, climb_uuid: 'c', reopened_in_session: true }),
      boardPinch({ ...commonProps, scale_max: 1.5 }),
      climbFirstAction({ ...commonProps, climb_uuid: 'c', action_type: 'queue', ms_since_open: 10 }),
      boardRenderSettingsChanged({ ...commonProps, field: 'mode', value: 'boardsesh' }),
      boardRenderPresetApplied(commonProps),
    ];
    for (const payload of payloads) {
      expect(payload.properties.board_name).toBe('kilter');
      expect(payload.properties.glow_falloff_source).toBe('flag');
    }
  });
});
