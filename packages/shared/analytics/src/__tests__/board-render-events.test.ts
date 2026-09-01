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
  glowFalloffSource: 'user',
  glowStyle: 'plain',
};

const EFFECTIVE_CLASSIC: BoardRenderEffectiveSettings = {
  mode: 'classic',
  glowFalloff: 'soft',
  glowFalloffSource: 'default',
  glowStyle: 'plain',
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
      glow_falloff_source: 'user',
      glow_style: 'plain',
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
        glow_falloff_source: 'user',
        glow_style: 'plain',
        climb_uuid: 'climb-1',
        reopened_in_session: false,
      },
    });
  });

  it('boardPinch carries the gesture extremes and the signed delta', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_CLASSIC, CONTEXT);
    expect(boardPinch({ ...commonProps, scale_max: 2.4, scale_min: 1, scale_delta: 1.4 })).toEqual({
      name: SHARED_EVENTS.BoardPinch,
      properties: { ...commonProps, scale_max: 2.4, scale_min: 1, scale_delta: 1.4 },
    });
  });

  it('boardPinch keeps a zoom-out delta negative', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_CLASSIC, CONTEXT);
    const payload = boardPinch({ ...commonProps, scale_max: 2.5, scale_min: 1.2, scale_delta: -1.3 });
    expect(payload.properties.scale_delta).toBe(-1.3);
    expect(payload.properties.scale_min).toBe(1.2);
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
      boardPinch({ ...commonProps, scale_max: 1.5, scale_min: 1, scale_delta: 0.5 }),
      climbFirstAction({ ...commonProps, climb_uuid: 'c', action_type: 'queue', ms_since_open: 10 }),
      boardRenderSettingsChanged({ ...commonProps, field: 'mode', value: 'boardsesh' }),
      boardRenderPresetApplied(commonProps),
    ];
    for (const payload of payloads) {
      expect(payload.properties.board_name).toBe('kilter');
      expect(payload.properties.glow_falloff_source).toBe('user');
    }
  });
});

// `Climb View Opened` used to be the glow-falloff experiment's custom exposure
// event. That experiment retired with the flag, so the event must now carry its
// own properties and nothing else — a stray `$feature_flag*` would attribute
// outcomes to a variant nothing is assigning.
describe('climbViewOpened after the experiment was retired', () => {
  function viewProperties(effective: BoardRenderEffectiveSettings) {
    const commonProps = buildBoardRenderTelemetryProps(effective, CONTEXT);
    return climbViewOpened({ ...commonProps, climb_uuid: 'climb-1', reopened_in_session: false }).properties;
  }

  it.each([
    [
      'a boardsesh render on the shipped falloff',
      { mode: 'boardsesh', glowFalloff: 'soft', glowFalloffSource: 'default' },
    ],
    ['a boardsesh render the climber tuned', { mode: 'boardsesh', glowFalloff: 'plateau', glowFalloffSource: 'user' }],
    ['a classic render', { mode: 'classic', glowFalloff: 'soft', glowFalloffSource: 'default' }],
  ] as const)('attaches no exposure properties to %s', (_label, effective) => {
    const properties = viewProperties(effective as BoardRenderEffectiveSettings);

    expect(Object.hasOwn(properties, '$feature_flag')).toBe(false);
    expect(Object.hasOwn(properties, '$feature_flag_response')).toBe(false);
    expect(Object.hasOwn(properties, '$feature_flag_called')).toBe(false);
  });

  it('still reports which drawing and falloff were used, for stratification', () => {
    const properties = viewProperties({
      mode: 'boardsesh',
      glowFalloff: 'plateau',
      glowFalloffSource: 'user',
      glowStyle: 'plain',
    });

    expect(properties.render_mode).toBe('boardsesh');
    expect(properties.glow_falloff).toBe('plateau');
    expect(properties.glow_falloff_source).toBe('user');
  });
});
