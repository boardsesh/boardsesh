import { randomUUID } from 'expo-crypto';
import type { QuantumLocalPlayer, QuantumSessionPlayerScope } from './quantum-layer-identity-store';

let soloPlayer: QuantumLocalPlayer | null = null;
let sessionPlayer: (QuantumSessionPlayerScope & QuantumLocalPlayer) | null = null;

/** Keep controller credentials in this page's memory. */
export async function getOrCreateQuantumSoloPlayer(
  generateUuid: () => string = randomUUID,
): Promise<QuantumLocalPlayer> {
  soloPlayer ??= { controllerUserUuid: generateUuid() };
  return soloPlayer;
}

export async function getQuantumSessionPlayer(scope: QuantumSessionPlayerScope): Promise<QuantumLocalPlayer | null> {
  if (sessionPlayer?.sessionId !== scope.sessionId || sessionPlayer.accountId !== scope.accountId) return null;
  return { controllerUserUuid: sessionPlayer.controllerUserUuid };
}

/** A reload loses the driver credential. A restored session can only read it. */
export async function rememberStartedQuantumSessionPlayer(
  scope: QuantumSessionPlayerScope,
  isCurrent: () => boolean,
  generateUuid: () => string = randomUUID,
): Promise<void> {
  if (!isCurrent() || (sessionPlayer?.sessionId === scope.sessionId && sessionPlayer.accountId === scope.accountId))
    return;
  sessionPlayer = { ...scope, controllerUserUuid: generateUuid() };
}
