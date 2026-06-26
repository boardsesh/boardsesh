import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { HOLD_STATE_MAP, STATE_TO_PRIMARY_CODE } from '@boardsesh/board-constants/hold-states';
import type { BoardName, HoldState } from '@boardsesh/shared-schema';
import { getPreference, removePreference, setPreference } from './preference-store';

export type HoldColorOverrideRole = Extract<HoldState, 'STARTING' | 'HAND' | 'FINISH' | 'FOOT'>;
export type HoldColorOverrides = Partial<Record<HoldColorOverrideRole, string>>;
export type HoldMarkerShape = 'circle' | 'triangle-up' | 'triangle-down' | 'square' | 'diamond' | 'octagon';
export type HoldShapeOverrides = Partial<Record<HoldColorOverrideRole, HoldMarkerShape>>;

export type HoldMarkerOverrides = {
  colors: HoldColorOverrides;
  shapes: HoldShapeOverrides;
  brushThickness: number;
  shapeSize: number;
};

export type RgbColor = {
  red: number;
  green: number;
  blue: number;
};

export const HOLD_COLOR_OVERRIDE_ROLES = ['STARTING', 'HAND', 'FINISH', 'FOOT'] as const;
export const HOLD_MARKER_SHAPES = ['circle', 'triangle-up', 'triangle-down', 'square', 'diamond', 'octagon'] as const;
export const DEFAULT_HOLD_COLOR_SIGNATURE = 'default';
export const DEFAULT_HOLD_MARKER_SHAPE: HoldMarkerShape = 'circle';
export const DEFAULT_HOLD_BRUSH_THICKNESS = 1;
export const MIN_HOLD_BRUSH_THICKNESS = 0.5;
export const MAX_HOLD_BRUSH_THICKNESS = 2;
export const DEFAULT_HOLD_SHAPE_SIZE = 1;
export const MIN_HOLD_SHAPE_SIZE = 0.5;
export const MAX_HOLD_SHAPE_SIZE = 2;

const STORAGE_KEY = 'holdColorOverrides';
const HEX_COLOR_PATTERN = /^#?[0-9a-fA-F]{6}$/;
const HOLD_COLOR_OVERRIDE_ROLE_SET = new Set<string>(HOLD_COLOR_OVERRIDE_ROLES);
const HOLD_MARKER_SHAPE_SET = new Set<string>(HOLD_MARKER_SHAPES);
const FALLBACK_ROLE_COLOR = '#8e8e93';
const DEFAULT_HOLD_MARKER_OVERRIDES: HoldMarkerOverrides = {
  colors: {},
  shapes: {},
  brushThickness: DEFAULT_HOLD_BRUSH_THICKNESS,
  shapeSize: DEFAULT_HOLD_SHAPE_SIZE,
};

type HoldColorSnapshot = {
  overrides: HoldColorOverrides;
  markerOverrides: HoldMarkerOverrides;
  shapes: HoldShapeOverrides;
  brushThickness: number;
  shapeSize: number;
  loaded: boolean;
  signature: string;
  renderSignature: string;
};

let currentMarkerOverrides: HoldMarkerOverrides = DEFAULT_HOLD_MARKER_OVERRIDES;
let hasLoaded = false;
let snapshot: HoldColorSnapshot = {
  overrides: currentMarkerOverrides.colors,
  markerOverrides: currentMarkerOverrides,
  shapes: currentMarkerOverrides.shapes,
  brushThickness: currentMarkerOverrides.brushThickness,
  shapeSize: currentMarkerOverrides.shapeSize,
  loaded: hasLoaded,
  signature: DEFAULT_HOLD_COLOR_SIGNATURE,
  renderSignature: DEFAULT_HOLD_COLOR_SIGNATURE,
};
const listeners = new Set<() => void>();
const SERVER_SNAPSHOT: HoldColorSnapshot = {
  overrides: {},
  markerOverrides: DEFAULT_HOLD_MARKER_OVERRIDES,
  shapes: {},
  brushThickness: DEFAULT_HOLD_BRUSH_THICKNESS,
  shapeSize: DEFAULT_HOLD_SHAPE_SIZE,
  loaded: false,
  signature: DEFAULT_HOLD_COLOR_SIGNATURE,
  renderSignature: DEFAULT_HOLD_COLOR_SIGNATURE,
};

function isHoldColorOverrideRole(value: unknown): value is HoldColorOverrideRole {
  return typeof value === 'string' && HOLD_COLOR_OVERRIDE_ROLE_SET.has(value);
}

function isHoldMarkerShape(value: unknown): value is HoldMarkerShape {
  return typeof value === 'string' && HOLD_MARKER_SHAPE_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) return null;
  const withoutHash = trimmed.replace('#', '').toLowerCase();
  return `#${withoutHash}`;
}

export function sanitizeHoldColorOverrides(rawOverrides: unknown): HoldColorOverrides {
  if (!isRecord(rawOverrides)) return {};

  const nextOverrides: HoldColorOverrides = {};
  for (const [role, rawColor] of Object.entries(rawOverrides)) {
    if (!isHoldColorOverrideRole(role)) continue;
    const color = normalizeHexColor(rawColor);
    if (color) nextOverrides[role] = color;
  }
  return nextOverrides;
}

export function sanitizeHoldShapeOverrides(rawOverrides: unknown): HoldShapeOverrides {
  if (!isRecord(rawOverrides)) return {};

  const nextOverrides: HoldShapeOverrides = {};
  for (const [role, rawShape] of Object.entries(rawOverrides)) {
    if (!isHoldColorOverrideRole(role) || !isHoldMarkerShape(rawShape)) continue;
    if (rawShape !== DEFAULT_HOLD_MARKER_SHAPE) nextOverrides[role] = rawShape;
  }
  return nextOverrides;
}

export function normalizeBrushThickness(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_HOLD_BRUSH_THICKNESS;
  const clamped = Math.min(MAX_HOLD_BRUSH_THICKNESS, Math.max(MIN_HOLD_BRUSH_THICKNESS, value));
  return Math.round(clamped * 10) / 10;
}

export function normalizeHoldShapeSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_HOLD_SHAPE_SIZE;
  const clamped = Math.min(MAX_HOLD_SHAPE_SIZE, Math.max(MIN_HOLD_SHAPE_SIZE, value));
  return Math.round(clamped * 10) / 10;
}

function getColorSource(rawOverrides: unknown): unknown {
  if (!isRecord(rawOverrides)) return {};
  return isRecord(rawOverrides.colors) ? rawOverrides.colors : rawOverrides;
}

export function sanitizeHoldMarkerOverrides(rawOverrides: unknown): HoldMarkerOverrides {
  if (!isRecord(rawOverrides)) return DEFAULT_HOLD_MARKER_OVERRIDES;

  return {
    colors: sanitizeHoldColorOverrides(getColorSource(rawOverrides)),
    shapes: sanitizeHoldShapeOverrides(rawOverrides.shapes),
    brushThickness: normalizeBrushThickness(rawOverrides.brushThickness),
    shapeSize: normalizeHoldShapeSize(rawOverrides.shapeSize),
  };
}

export function buildHoldColorOverrideSignature(overrides: HoldColorOverrides): string {
  const parts: string[] = [];
  for (const role of HOLD_COLOR_OVERRIDE_ROLES) {
    const color = normalizeHexColor(overrides[role]);
    if (color) parts.push(`${role.toLowerCase()}-${color.slice(1)}`);
  }
  return parts.length > 0 ? parts.join('.') : DEFAULT_HOLD_COLOR_SIGNATURE;
}

export function buildHoldRenderOverrideSignature(overrides: HoldMarkerOverrides): string {
  const sanitizedOverrides = sanitizeHoldMarkerOverrides(overrides);
  const markerParts: string[] = [];
  const colorSignature = buildHoldColorOverrideSignature(sanitizedOverrides.colors);

  for (const role of HOLD_COLOR_OVERRIDE_ROLES) {
    const shape = sanitizedOverrides.shapes[role];
    if (shape) markerParts.push(`${role.toLowerCase()}-${shape}`);
  }

  if (sanitizedOverrides.brushThickness !== DEFAULT_HOLD_BRUSH_THICKNESS) {
    markerParts.push(`brush-${sanitizedOverrides.brushThickness.toFixed(1)}`);
  }

  if (sanitizedOverrides.shapeSize !== DEFAULT_HOLD_SHAPE_SIZE) {
    markerParts.push(`size-${sanitizedOverrides.shapeSize.toFixed(1)}`);
  }

  if (markerParts.length === 0) return colorSignature;

  const parts: string[] = [];
  if (colorSignature !== DEFAULT_HOLD_COLOR_SIGNATURE) parts.push(`colors-${colorSignature}`);
  parts.push(...markerParts);
  return parts.length > 0 ? parts.join('.') : DEFAULT_HOLD_COLOR_SIGNATURE;
}

export function hasHoldColorOverrides(overrides: HoldColorOverrides): boolean {
  return buildHoldColorOverrideSignature(overrides) !== DEFAULT_HOLD_COLOR_SIGNATURE;
}

export function hasHoldMarkerOverrides(overrides: HoldMarkerOverrides): boolean {
  return buildHoldRenderOverrideSignature(overrides) !== DEFAULT_HOLD_COLOR_SIGNATURE;
}

function compactHoldMarkerOverrides(overrides: HoldMarkerOverrides): Partial<HoldMarkerOverrides> {
  const sanitizedOverrides = sanitizeHoldMarkerOverrides(overrides);
  const storedOverrides: Partial<HoldMarkerOverrides> = {};
  if (hasHoldColorOverrides(sanitizedOverrides.colors)) storedOverrides.colors = sanitizedOverrides.colors;
  if (Object.keys(sanitizedOverrides.shapes).length > 0) storedOverrides.shapes = sanitizedOverrides.shapes;
  if (sanitizedOverrides.brushThickness !== DEFAULT_HOLD_BRUSH_THICKNESS) {
    storedOverrides.brushThickness = sanitizedOverrides.brushThickness;
  }
  if (sanitizedOverrides.shapeSize !== DEFAULT_HOLD_SHAPE_SIZE) {
    storedOverrides.shapeSize = sanitizedOverrides.shapeSize;
  }
  return storedOverrides;
}

function notify(): void {
  snapshot = {
    overrides: currentMarkerOverrides.colors,
    markerOverrides: currentMarkerOverrides,
    shapes: currentMarkerOverrides.shapes,
    brushThickness: currentMarkerOverrides.brushThickness,
    shapeSize: currentMarkerOverrides.shapeSize,
    loaded: hasLoaded,
    signature: buildHoldColorOverrideSignature(currentMarkerOverrides.colors),
    renderSignature: buildHoldRenderOverrideSignature(currentMarkerOverrides),
  };
  for (const listener of listeners) listener();
}

export async function loadHoldColorOverrides(): Promise<HoldColorOverrides> {
  const markerOverrides = await loadHoldMarkerOverrides();
  return markerOverrides.colors;
}

export async function loadHoldMarkerOverrides(): Promise<HoldMarkerOverrides> {
  if (hasLoaded) return currentMarkerOverrides;
  const storedOverrides = await getPreference<unknown>(STORAGE_KEY);
  if (hasLoaded) return currentMarkerOverrides;
  currentMarkerOverrides = sanitizeHoldMarkerOverrides(storedOverrides);
  hasLoaded = true;
  notify();
  return currentMarkerOverrides;
}

export async function setHoldColorOverridesPreference(nextOverrides: HoldColorOverrides): Promise<void> {
  if (!hasLoaded) await loadHoldMarkerOverrides();
  await setHoldMarkerOverridesPreference({
    ...currentMarkerOverrides,
    colors: sanitizeHoldColorOverrides(nextOverrides),
  });
}

export async function setHoldMarkerOverridesPreference(nextOverrides: HoldMarkerOverrides): Promise<void> {
  currentMarkerOverrides = sanitizeHoldMarkerOverrides(nextOverrides);
  hasLoaded = true;
  notify();

  const storedOverrides = compactHoldMarkerOverrides(currentMarkerOverrides);
  if (Object.keys(storedOverrides).length > 0) {
    await setPreference(STORAGE_KEY, storedOverrides);
  } else {
    await removePreference(STORAGE_KEY);
  }
}

export async function setHoldColorOverridePreference(role: HoldColorOverrideRole, color: string | null): Promise<void> {
  if (!hasLoaded) await loadHoldMarkerOverrides();
  const nextColors: HoldColorOverrides = { ...currentMarkerOverrides.colors };
  const normalizedColor = normalizeHexColor(color);
  if (normalizedColor) {
    nextColors[role] = normalizedColor;
  } else {
    delete nextColors[role];
  }
  await setHoldMarkerOverridesPreference({ ...currentMarkerOverrides, colors: nextColors });
}

export async function setHoldShapeOverridePreference(
  role: HoldColorOverrideRole,
  shape: HoldMarkerShape,
): Promise<void> {
  if (!hasLoaded) await loadHoldMarkerOverrides();
  const nextShapes: HoldShapeOverrides = { ...currentMarkerOverrides.shapes };
  if (shape === DEFAULT_HOLD_MARKER_SHAPE) {
    delete nextShapes[role];
  } else {
    nextShapes[role] = shape;
  }
  await setHoldMarkerOverridesPreference({ ...currentMarkerOverrides, shapes: nextShapes });
}

export async function setHoldRoleMarkerOverridePreference(
  role: HoldColorOverrideRole,
  color: string | null,
  shape: HoldMarkerShape,
): Promise<void> {
  if (!hasLoaded) await loadHoldMarkerOverrides();

  const nextColors: HoldColorOverrides = { ...currentMarkerOverrides.colors };
  const normalizedColor = normalizeHexColor(color);
  if (normalizedColor) {
    nextColors[role] = normalizedColor;
  } else {
    delete nextColors[role];
  }

  const nextShapes: HoldShapeOverrides = { ...currentMarkerOverrides.shapes };
  if (shape === DEFAULT_HOLD_MARKER_SHAPE) {
    delete nextShapes[role];
  } else {
    nextShapes[role] = shape;
  }

  await setHoldMarkerOverridesPreference({
    ...currentMarkerOverrides,
    colors: nextColors,
    shapes: nextShapes,
  });
}

export async function setHoldBrushThicknessPreference(brushThickness: number): Promise<void> {
  if (!hasLoaded) await loadHoldMarkerOverrides();
  await setHoldMarkerOverridesPreference({
    ...currentMarkerOverrides,
    brushThickness: normalizeBrushThickness(brushThickness),
  });
}

export async function setHoldShapeSizePreference(shapeSize: number): Promise<void> {
  if (!hasLoaded) await loadHoldMarkerOverrides();
  await setHoldMarkerOverridesPreference({
    ...currentMarkerOverrides,
    shapeSize: normalizeHoldShapeSize(shapeSize),
  });
}

let loadPromise: Promise<HoldMarkerOverrides> | null = null;
function ensureHoldMarkerOverridesLoaded(): Promise<HoldMarkerOverrides> {
  if (!loadPromise) {
    loadPromise = loadHoldMarkerOverrides().catch((error: unknown) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): HoldColorSnapshot {
  return snapshot;
}

function getServerSnapshot(): HoldColorSnapshot {
  return SERVER_SNAPSHOT;
}

export function useHoldColorOverrides(): {
  overrides: HoldColorOverrides;
  markerOverrides: HoldMarkerOverrides;
  shapes: HoldShapeOverrides;
  brushThickness: number;
  shapeSize: number;
  loaded: boolean;
  signature: string;
  renderSignature: string;
  setRoleOverride: (role: HoldColorOverrideRole, color: string | null) => void;
  setRoleShapeOverride: (role: HoldColorOverrideRole, shape: HoldMarkerShape) => void;
  setRoleMarkerOverride: (role: HoldColorOverrideRole, color: string | null, shape: HoldMarkerShape) => void;
  setBrushThickness: (brushThickness: number) => void;
  setShapeSize: (shapeSize: number) => void;
  setOverrides: (nextOverrides: HoldColorOverrides) => void;
  resetOverrides: () => void;
} {
  const { overrides, markerOverrides, shapes, brushThickness, shapeSize, loaded, signature, renderSignature } =
    useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    ensureHoldMarkerOverridesLoaded().catch(() => {});
  }, []);

  const setRoleOverride = useCallback((role: HoldColorOverrideRole, color: string | null) => {
    void setHoldColorOverridePreference(role, color);
  }, []);

  const setRoleShapeOverride = useCallback((role: HoldColorOverrideRole, shape: HoldMarkerShape) => {
    void setHoldShapeOverridePreference(role, shape);
  }, []);

  const setRoleMarkerOverride = useCallback(
    (role: HoldColorOverrideRole, color: string | null, shape: HoldMarkerShape) => {
      void setHoldRoleMarkerOverridePreference(role, color, shape);
    },
    [],
  );

  const setBrushThickness = useCallback((nextBrushThickness: number) => {
    void setHoldBrushThicknessPreference(nextBrushThickness);
  }, []);

  const setShapeSize = useCallback((nextShapeSize: number) => {
    void setHoldShapeSizePreference(nextShapeSize);
  }, []);

  const setOverrides = useCallback((nextOverrides: HoldColorOverrides) => {
    void setHoldColorOverridesPreference(nextOverrides);
  }, []);

  const resetOverrides = useCallback(() => {
    void setHoldMarkerOverridesPreference(DEFAULT_HOLD_MARKER_OVERRIDES);
  }, []);

  return {
    overrides,
    markerOverrides,
    shapes,
    brushThickness,
    shapeSize,
    loaded,
    signature,
    renderSignature,
    setRoleOverride,
    setRoleShapeOverride,
    setRoleMarkerOverride,
    setBrushThickness,
    setShapeSize,
    setOverrides,
    resetOverrides,
  };
}

export function getDefaultHoldRoleColor(
  boardName: BoardName,
  role: HoldColorOverrideRole,
  variant: 'display' | 'led' = 'display',
): string {
  const roleCode = STATE_TO_PRIMARY_CODE[boardName]?.[role];
  if (roleCode === undefined) return FALLBACK_ROLE_COLOR;
  const roleInfo = HOLD_STATE_MAP[boardName]?.[roleCode];
  if (!roleInfo) return FALLBACK_ROLE_COLOR;
  return variant === 'display' ? (roleInfo.displayColor ?? roleInfo.color) : roleInfo.color;
}

export function getEffectiveHoldRoleColor(
  boardName: BoardName,
  role: HoldColorOverrideRole,
  overrides: HoldColorOverrides,
  variant: 'display' | 'led' = 'display',
): string {
  return overrides[role] ?? getDefaultHoldRoleColor(boardName, role, variant);
}

export function getEffectiveHoldStateColor(
  state: HoldState,
  fallbackColor: string,
  overrides: HoldColorOverrides,
): string {
  return isHoldColorOverrideRole(state) ? (overrides[state] ?? fallbackColor) : fallbackColor;
}

export function getEffectiveHoldRoleShape(role: HoldColorOverrideRole, overrides: HoldShapeOverrides): HoldMarkerShape {
  return overrides[role] ?? DEFAULT_HOLD_MARKER_SHAPE;
}

export function getEffectiveHoldStateShape(state: HoldState, overrides: HoldShapeOverrides): HoldMarkerShape {
  return isHoldColorOverrideRole(state) ? getEffectiveHoldRoleShape(state, overrides) : DEFAULT_HOLD_MARKER_SHAPE;
}

export function getBluetoothColorOverrides(
  overrides: HoldColorOverrides | HoldMarkerOverrides,
): HoldColorOverrides | undefined {
  const sanitizedOverrides = sanitizeHoldColorOverrides(getColorSource(overrides));
  return hasHoldColorOverrides(sanitizedOverrides) ? sanitizedOverrides : undefined;
}

export function hexToRgb(hexColor: string): RgbColor | null {
  const normalizedColor = normalizeHexColor(hexColor);
  if (!normalizedColor) return null;
  const hex = normalizedColor.slice(1);
  return {
    red: parseInt(hex.slice(0, 2), 16),
    green: parseInt(hex.slice(2, 4), 16),
    blue: parseInt(hex.slice(4, 6), 16),
  };
}

export function rgbToHex({ red, green, blue }: RgbColor): string | null {
  if (!isRgbChannel(red) || !isRgbChannel(green) || !isRgbChannel(blue)) return null;
  const hex = [red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('');
  return `#${hex}`;
}

export function parseRgbChannel(value: string): number | null {
  if (!/^\d{1,3}$/.test(value.trim())) return null;
  const channel = Number(value);
  return isRgbChannel(channel) ? channel : null;
}

function isRgbChannel(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}
