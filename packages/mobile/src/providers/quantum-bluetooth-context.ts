import { createContext, useContext } from 'react';
import type { QuantumBluetoothState, QuantumBluetoothActions } from './quantum-bluetooth-provider';

export const QuantumBluetoothStateContext = createContext<QuantumBluetoothState | null>(null);
export const QuantumBluetoothActionsContext = createContext<QuantumBluetoothActions | null>(null);

export function useQuantumBluetoothState(): QuantumBluetoothState {
  const state = useContext(QuantumBluetoothStateContext);
  if (!state) throw new Error('useQuantumBluetoothState must be used within QuantumBluetoothProvider');
  return state;
}

export function useQuantumBluetoothActions(): QuantumBluetoothActions {
  const actions = useContext(QuantumBluetoothActionsContext);
  if (!actions) throw new Error('useQuantumBluetoothActions must be used within QuantumBluetoothProvider');
  return actions;
}

/** Non-throwing reads let shared chrome keep working before the wrapper mounts,
 * and let tests or utility surfaces render without Quantum support. */
export function useOptionalQuantumBluetoothState(): QuantumBluetoothState | null {
  return useContext(QuantumBluetoothStateContext);
}

export function useOptionalQuantumBluetoothActions(): QuantumBluetoothActions | null {
  return useContext(QuantumBluetoothActionsContext);
}
