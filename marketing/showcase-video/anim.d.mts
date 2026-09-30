// Types for anim.mjs, so the Node-side tests can hold the browser helpers to
// the same numbers as scripts/lib/showcase-video/render.ts.

export type Point = { x: number; y: number };
export type Pose = { cx: number; cy: number; scale?: number; rx?: number; ry?: number; rz?: number };
export type Curve = { points: Point[]; lengths: number[]; total: number };
export type Sample = { t: number; x: number; y: number; width: number; height: number };

export function clamp(value: number, min?: number, max?: number): number;
export function lerp(from: number, to: number, amount: number): number;
export function progress(frame: number, start: number, duration: number): number;
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number;
export const easeOut: (x: number) => number;
export const easeInOut: (x: number) => number;
export const easeIn: (x: number) => number;
export function spring(seconds: number, options?: { zeta?: number; period?: number }): number;
export function springAt(
  frame: number,
  startFrame: number,
  fps: number,
  options?: { zeta?: number; period?: number },
): number;
export function hexToRgb(hex: string): number[];
export function rgbToOklab(rgb: number[]): number[];
export function oklabToRgb(lab: number[]): number[];
export function mixOklab(fromHex: string, toHex: string, amount: number): string;
export function projectPoint(
  pose: Pose,
  x: number,
  y: number,
  options: { perspective: number; originX: number; originY: number },
): Point;
export function anchorAt<T extends Sample>(samples: readonly T[] | null | undefined, t: number): T | null;
export function catmullRomPolyline(points: readonly Point[], samplesPerSegment?: number): Curve;
export function pointAtLength(curve: Curve, length: number): Point;
export function lengthNearest(curve: Curve, point: Point): number;
export function polylinePath(points: readonly Point[]): string;
export type StageBackground = { from: 'dark' | 'light'; to: 'dark' | 'light'; amount: number };
export function backgroundAt(
  scenes: ReadonlyArray<Readonly<{ startFrame: number; background: 'dark' | 'light' }>>,
  frame: number,
  lead: number,
  out: number,
): StageBackground;
export function orthoPath(points: readonly Point[], radius?: number): string;
