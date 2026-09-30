import * as React from 'react';

/**
 * The board — always a dark panel so LEDs read true. Coordinates (A–K × 1–18) sit outside
 * the panel, crop marks frame it, unlit holds are drawn for realism, lit holds glow.
 * Fluid: set the width on the parent; height follows cols:rows.
 * @startingPoint section="Climbing" subtitle="Board, grades, rows and readouts" viewport="700x640"
 */
export interface BoardViewProps {
  board?: 'moon' | 'kilter' | 'tension';
  rows?: number;
  cols?: number;
  /** r counts from the bottom (1-based), c is 0-based (A = 0) */
  holds?: { r: number; c: number; role: 'start' | 'hand' | 'foot' | 'finish' }[];
  /** Glow on (board is lit) or dimmed preview */
  lit?: boolean;
  /** Row numbers left, column letters below */
  showLabels?: boolean;
  /** Draw unlit holds */
  showHolds?: boolean;
  cropMarks?: boolean;
  onHoldClick?: (h: { r: number; c: number; role?: string }) => void;
  style?: React.CSSProperties;
}

export declare function BoardView(props: BoardViewProps): React.JSX.Element;
/** Coordinates string like "F8 C10 E12", optionally for one role. */
export declare function holdCoords(holds: BoardViewProps['holds'], role?: string): string;
