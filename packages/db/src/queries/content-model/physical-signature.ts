export interface PhysicalSignatureHold {
  pid: number;
  holeId?: number;
  mirroredHoleId?: number;
  state: 'STARTING' | 'HAND' | 'FINISH' | 'FOOT';
}

export interface PhysicalSignatureInput {
  boardType: string;
  layoutId: number | null;
  productId?: number | null;
  fingerprint: string | null;
  holds: readonly PhysicalSignatureHold[];
}

export interface PhysicalProblemIdentity {
  key: string;
  /** Whether the mirrored whole-route signature is the canonical orientation. */
  mirrored: boolean;
}

interface PhysicalSignatureToken {
  holdId: number;
  state: PhysicalSignatureHold['state'];
}

function signatureTokens(input: PhysicalSignatureInput, mirrored: boolean): PhysicalSignatureToken[] {
  return input.holds
    .map((hold) => ({
      holdId: mirrored ? (hold.mirroredHoleId ?? hold.holeId ?? hold.pid) : (hold.holeId ?? hold.pid),
      state: hold.state,
    }))
    .sort((left, right) => left.holdId - right.holdId || left.state.localeCompare(right.state));
}

function compareSignatureTokens(
  left: readonly PhysicalSignatureToken[],
  right: readonly PhysicalSignatureToken[],
): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index++) {
    const leftToken = left[index]!;
    const rightToken = right[index]!;
    const comparison = leftToken.holdId - rightToken.holdId || leftToken.state.localeCompare(rightToken.state);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function renderSignature(tokens: readonly PhysicalSignatureToken[]): string {
  return tokens.map((token) => `${token.holdId}:${token.state}`).join(',');
}

/**
 * Angle-independent physical-problem identity used for train/validation/test
 * assignment. Kilter's source fingerprint is authoritative; boards without one
 * fall back to a route-level mirror canonicalization.
 *
 * Canonicalization must happen across the whole route, not independently per
 * hold: taking min(hole, mirrored_hole) per hold can make two different
 * asymmetric routes collide. STARTING/HAND/FINISH also remain distinct because
 * those states define different physical problems even though all are hand
 * holds for model features.
 */
export function physicalProblemIdentity(input: PhysicalSignatureInput): PhysicalProblemIdentity {
  if (input.layoutId !== null && input.fingerprint) {
    return {
      key: `${input.boardType}\u0000${input.layoutId}\u0000${input.fingerprint}`,
      mirrored: false,
    };
  }
  const originalTokens = signatureTokens(input, false);
  const mirroredTokens = signatureTokens(input, true);
  const mirrored = compareSignatureTokens(mirroredTokens, originalTokens) < 0;
  const routeSignature = renderSignature(mirrored ? mirroredTokens : originalTokens);
  // Tension layouts within one product family share a physical hold system, so
  // product scope deliberately pools them. MoonBoard editions reuse the same
  // A-K cell ids for different physical hold arrangements; layout scope is
  // therefore mandatory to prevent cross-edition collisions.
  const boardScope = input.boardType === 'moonboard' ? input.layoutId : (input.productId ?? input.layoutId);
  return {
    key: `${input.boardType}\u0000${boardScope ?? 'unknown'}\u0000${routeSignature}`,
    mirrored,
  };
}

export function physicalProblemKey(input: PhysicalSignatureInput): string {
  return physicalProblemIdentity(input).key;
}
