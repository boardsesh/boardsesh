import * as React from 'react';

/**
 * Hairline table row for a problem: No. · name · setter / sends / quality / BM · grade tag.
 * Grade tag is solid ink when sent, outline when open.
 * @startingPoint section="Climbing" subtitle="Board, grades, rows and readouts" viewport="700x640"
 */
export interface ProblemRowProps {
  problem: {
    name: string; grade: string; setter?: string; ascents?: number | string;
    /** 0–3 average, shown as ★2.9 */
    quality?: number | string; stars?: number;
    benchmark?: boolean; sent?: boolean; favorite?: boolean;
  };
  /** Rank / list position, printed as 01, 02… */
  index?: number;
  selected?: boolean;
  onClick?: () => void;
  onFavorite?: () => void;
  /** Bottom hairline (default true) */
  divider?: boolean;
  style?: React.CSSProperties;
}

export declare function ProblemRow(props: ProblemRowProps): React.JSX.Element;
