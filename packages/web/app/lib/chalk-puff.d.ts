interface ChalkPuffOptions {
  particleCount?: number;
  angle?: number;
  spread?: number;
  startVelocity?: number;
  decay?: number;
  gravity?: number;
  drift?: number;
  ticks?: number;
  origin?: { x?: number; y?: number };
  shapes?: string[];
  zIndex?: number;
  colors?: string[];
  disableForReducedMotion?: boolean;
  scalar?: number;
  flat?: boolean;
}

interface ChalkPuffFire {
  (options?: ChalkPuffOptions): Promise<void> | null;
  reset: () => void;
}

declare const chalkPuff: ChalkPuffFire;
export default chalkPuff;
