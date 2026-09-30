import * as React from 'react';

/** Mono readout: uppercase label over a number. `tile` = hairline card, `cell` = bare (inside ReadoutStrip). */
export interface StatTileProps {
  label: string;
  value: string | number;
  unit?: string;
  /** "+8 vs Aug" / "-3%" — rendered with ↑ / ↓ */
  delta?: string;
  icon?: string;
  variant?: 'tile' | 'cell';
  style?: React.CSSProperties;
}

/**
 * Row of readouts between hairlines, split by vertical hairlines — SENDS 241 | FLASH 28% | QUALITY 2.9.
 * @startingPoint section="Climbing" subtitle="Board, grades, rows and readouts" viewport="700x640"
 */
export interface ReadoutStripProps {
  items: { label: string; value: string | number; unit?: string }[];
  style?: React.CSSProperties;
}

export declare function StatTile(props: StatTileProps): React.JSX.Element;
export declare function ReadoutStrip(props: ReadoutStripProps): React.JSX.Element;
