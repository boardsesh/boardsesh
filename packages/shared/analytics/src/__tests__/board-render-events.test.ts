import { describe, it, expect } from 'vitest';
import { SHARED_EVENTS } from '../events';
import {
  boardPinch,
  boardRenderFailed,
  boardRenderPresetApplied,
  boardRenderSettingsChanged,
  buildBoardRenderTelemetryProps,
  classifyBoardRenderErrorCode,
  climbFirstAction,
  climbViewOpened,
  type BoardRenderContext,
  type BoardRenderEffectiveSettings,
} from '../board-render-events';

const EFFECTIVE_AURA: BoardRenderEffectiveSettings = {
  mode: 'aura',
  glowFalloff: 'plateau',
  glowFalloffSource: 'user',
};

const EFFECTIVE_CLASSIC: BoardRenderEffectiveSettings = {
  mode: 'classic',
  glowFalloff: 'soft',
  glowFalloffSource: 'default',
};

const CONTEXT: BoardRenderContext = { boardName: 'kilter', layoutId: 1, sizeId: 2 };

describe('buildBoardRenderTelemetryProps', () => {
  it('assembles the common props in snake_case', () => {
    expect(buildBoardRenderTelemetryProps(EFFECTIVE_AURA, CONTEXT)).toEqual({
      board_name: 'kilter',
      layout_id: 1,
      size_id: 2,
      render_mode: 'aura',
      glow_falloff: 'plateau',
      glow_falloff_source: 'user',
    });
  });

  it('omits preset_id and palette_id entirely when absent', () => {
    const props = buildBoardRenderTelemetryProps(EFFECTIVE_CLASSIC, CONTEXT);
    expect(Object.hasOwn(props, 'preset_id')).toBe(false);
    expect(Object.hasOwn(props, 'palette_id')).toBe(false);
  });

  it('carries preset_id and palette_id when the context has them', () => {
    const props = buildBoardRenderTelemetryProps(EFFECTIVE_AURA, {
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
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_AURA, CONTEXT);
    expect(climbViewOpened({ ...commonProps, climb_uuid: 'climb-1', reopened_in_session: false })).toEqual({
      name: SHARED_EVENTS.ClimbViewOpened,
      properties: {
        board_name: 'kilter',
        layout_id: 1,
        size_id: 2,
        render_mode: 'aura',
        glow_falloff: 'plateau',
        glow_falloff_source: 'user',
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
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_AURA, CONTEXT);
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
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_AURA, {
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
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_AURA, CONTEXT);
    const payloads = [
      climbViewOpened({ ...commonProps, climb_uuid: 'c', reopened_in_session: true }),
      boardPinch({ ...commonProps, scale_max: 1.5, scale_min: 1, scale_delta: 0.5 }),
      climbFirstAction({ ...commonProps, climb_uuid: 'c', action_type: 'queue', ms_since_open: 10 }),
      boardRenderSettingsChanged({ ...commonProps, field: 'mode', value: 'aura' }),
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
    ['an Aura render on the shipped falloff', { mode: 'aura', glowFalloff: 'soft', glowFalloffSource: 'default' }],
    ['an Aura render the climber tuned', { mode: 'aura', glowFalloff: 'plateau', glowFalloffSource: 'user' }],
    ['a classic render', { mode: 'classic', glowFalloff: 'soft', glowFalloffSource: 'default' }],
  ] as const)('attaches no exposure properties to %s', (_label, effective) => {
    const properties = viewProperties(effective as BoardRenderEffectiveSettings);

    expect(Object.hasOwn(properties, '$feature_flag')).toBe(false);
    expect(Object.hasOwn(properties, '$feature_flag_response')).toBe(false);
    expect(Object.hasOwn(properties, '$feature_flag_called')).toBe(false);
  });

  it('still reports which drawing and falloff were used, for stratification', () => {
    const properties = viewProperties({
      mode: 'aura',
      glowFalloff: 'plateau',
      glowFalloffSource: 'user',
    });

    expect(properties.render_mode).toBe('aura');
    expect(properties.glow_falloff).toBe('plateau');
    expect(properties.glow_falloff_source).toBe('user');
  });
});

// The message a render failure arrives with is never safe to send: it
// interpolates the cache key, the cache path and, on iOS, OS prose in whatever
// language the phone is set to. `classifyBoardRenderErrorCode` is the whole
// privacy and cardinality boundary for `Board Render Failed`.
describe('classifyBoardRenderErrorCode', () => {
  it('prefers a numeric code the native layer named', () => {
    expect(classifyBoardRenderErrorCode('Rust render failed with code -2')).toBe('code_-2');
    expect(classifyBoardRenderErrorCode('renderHoldsOverlay failed with code 7')).toBe('code_7');
  });

  it('normalises a padded code so one fault is one bucket', () => {
    expect(classifyBoardRenderErrorCode('failed with code -002')).toBe('code_-2');
  });

  it('buckets the prose shapes when there is no code', () => {
    expect(classifyBoardRenderErrorCode('PNG encoding returned null')).toBe('png');
    expect(classifyBoardRenderErrorCode('could not build a CGImage from the surface')).toBe('cgimage');
    expect(classifyBoardRenderErrorCode('ENOSPC')).toBe('write');
    expect(classifyBoardRenderErrorCode('BoardRenderer module is not available')).toBe('module');
    expect(
      classifyBoardRenderErrorCode(
        'Marker shape, size, and brush overrides require a rebuilt BoardRenderer native binary',
      ),
    ).toBe('capability');
    expect(classifyBoardRenderErrorCode('something nobody has seen before')).toBe('other');
  });

  // The generated filename ends in `.png` and rides along in EVERY iOS write
  // failure, so a bare /png/i test would label a full volume as a PNG-encoding
  // fault and empty the `write` bucket entirely.
  it('does not read the overlay filename as a PNG encoding fault', () => {
    const outOfSpace =
      'The operation couldn’t be completed. You can’t save the file “v5_abc123.png” because the volume “User” is out of space.';
    expect(classifyBoardRenderErrorCode(outOfSpace)).toBe('write');
  });

  it('never returns anything derived from the message itself', () => {
    const code = classifyBoardRenderErrorCode('You can’t save the file “v5_secret-cache-key.png”');
    expect(code).not.toContain('secret-cache-key');
    expect(code).not.toContain('.png');
  });
});

describe('boardRenderFailed', () => {
  const FAILURE_FIELDS = {
    surface: 'full',
    error_code: 'code_-2',
    render_width: null,
    frames_length: 42,
    failures_this_session: 3,
  } as const;

  it('pairs the name with the common props plus the failure fields', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_AURA, CONTEXT);
    expect(
      boardRenderFailed({ ...commonProps, ...FAILURE_FIELDS, stage: 'native', failure_kind: 'render_failed' }),
    ).toEqual({
      name: SHARED_EVENTS.BoardRenderFailed,
      properties: {
        board_name: 'kilter',
        layout_id: 1,
        size_id: 2,
        render_mode: 'aura',
        glow_falloff: 'plateau',
        glow_falloff_source: 'user',
        surface: 'full',
        stage: 'native',
        failure_kind: 'render_failed',
        error_code: 'code_-2',
        render_width: null,
        frames_length: 42,
        failures_this_session: 3,
      },
    });
  });

  it('carries the image-load kinds under the image_load stage', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_CLASSIC, CONTEXT);
    const payload = boardRenderFailed({
      ...commonProps,
      ...FAILURE_FIELDS,
      surface: 'thumbnail',
      error_code: 'other',
      render_width: 400,
      stage: 'image_load',
      failure_kind: 'cache_entry_missing',
    });

    expect(payload.properties.stage).toBe('image_load');
    expect(payload.properties.failure_kind).toBe('cache_entry_missing');
    expect(payload.properties.surface).toBe('thumbnail');
    expect(payload.properties.render_width).toBe(400);
  });

  it('stays stratifiable — the common props ride along on a failure too', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_AURA, CONTEXT);
    const payload = boardRenderFailed({
      ...commonProps,
      ...FAILURE_FIELDS,
      stage: 'native',
      failure_kind: 'capability_fallback',
    });

    expect(payload.properties.board_name).toBe('kilter');
    expect(payload.properties.render_mode).toBe('aura');
    expect(payload.properties.glow_falloff_source).toBe('user');
  });
});

// The config stage is the one that fails silently — the Rust renderer drops
// unmatched holds and returns Ok — so it is the reason this event has a stage
// at all rather than just a failure kind.
describe('boardRenderFailed — the config stage', () => {
  const BASE_FIELDS = {
    surface: 'full',
    render_width: null,
    frames_length: 16,
    failures_this_session: 1,
  } as const;

  it('carries the lit and unmatched counts, never the ids', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_AURA, CONTEXT);
    const payload = boardRenderFailed({
      ...commonProps,
      ...BASE_FIELDS,
      stage: 'config',
      failure_kind: 'no_matching_holds',
      error_code: 'no_matching_holds',
      lit_count: 12,
      unmatched_count: 12,
    });

    expect(payload.name).toBe(SHARED_EVENTS.BoardRenderFailed);
    expect(payload.properties).toMatchObject({
      stage: 'config',
      failure_kind: 'no_matching_holds',
      lit_count: 12,
      unmatched_count: 12,
    });
  });

  it('separates a partial overhang from a climb that would draw nothing', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_CLASSIC, CONTEXT);
    const payload = boardRenderFailed({
      ...commonProps,
      ...BASE_FIELDS,
      stage: 'config',
      failure_kind: 'partial_hold_match',
      error_code: 'other',
      lit_count: 12,
      unmatched_count: 3,
    });

    expect(payload.properties.failure_kind).toBe('partial_hold_match');
    expect(payload.properties.unmatched_count).toBeLessThan(payload.properties.lit_count as number);
  });

  it('omits the counts entirely on the stages they mean nothing for', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_AURA, CONTEXT);
    const payload = boardRenderFailed({
      ...commonProps,
      ...BASE_FIELDS,
      stage: 'native',
      failure_kind: 'render_failed',
      error_code: 'code_-2',
    });

    expect(Object.hasOwn(payload.properties, 'lit_count')).toBe(false);
    expect(Object.hasOwn(payload.properties, 'unmatched_count')).toBe(false);
  });

  it('keeps the play board separate from every other full-size surface', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_AURA, CONTEXT);
    const surfaces = (['play', 'full', 'thumbnail'] as const).map(
      (surface) =>
        boardRenderFailed({
          ...commonProps,
          ...BASE_FIELDS,
          surface,
          stage: 'native',
          failure_kind: 'render_failed',
          error_code: 'code_-2',
        }).properties.surface,
    );

    expect(surfaces).toEqual(['play', 'full', 'thumbnail']);
  });

  it('gives partial_hold_match its own error code rather than lumping it into other', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_CLASSIC, CONTEXT);
    const payload = boardRenderFailed({
      ...commonProps,
      ...BASE_FIELDS,
      stage: 'config',
      failure_kind: 'partial_hold_match',
      error_code: 'partial_hold_match',
      lit_count: 9,
      unmatched_count: 2,
    });

    expect(payload.properties.error_code).toBe('partial_hold_match');
  });

  it('carries the paint-timeout kind under the image_load stage', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_AURA, CONTEXT);
    const payload = boardRenderFailed({
      ...commonProps,
      ...BASE_FIELDS,
      stage: 'image_load',
      failure_kind: 'paint_timeout',
      error_code: 'paint_timeout',
    });

    expect(payload.properties.failure_kind).toBe('paint_timeout');
    expect(payload.properties.error_code).toBe('paint_timeout');
  });

  // Issue #5187. A stalled render is the one failure that has not happened yet,
  // and the only thing worth knowing about it is WHERE it is waiting: our own
  // queue behind other surfaces, or inside native. Pooling the two would
  // describe nothing, so all four position fields ride the event verbatim.
  it('carries the stall position under a native render_stalled', () => {
    const commonProps = buildBoardRenderTelemetryProps(EFFECTIVE_AURA, CONTEXT);
    const payload = boardRenderFailed({
      ...commonProps,
      ...BASE_FIELDS,
      surface: 'play',
      stage: 'native',
      failure_kind: 'render_stalled',
      error_code: 'render_stalled',
      stall_state: 'queued',
      queue_depth: 3,
      dispatched_count: 1,
      ms_waiting: 6001,
    });

    expect(payload.properties).toMatchObject({
      stage: 'native',
      failure_kind: 'render_stalled',
      error_code: 'render_stalled',
      surface: 'play',
      stall_state: 'queued',
      queue_depth: 3,
      dispatched_count: 1,
      ms_waiting: 6001,
    });
  });
});
