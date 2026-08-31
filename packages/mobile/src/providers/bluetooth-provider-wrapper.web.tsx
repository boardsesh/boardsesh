import type { ReactNode } from 'react';
import { QUANTUM_MODELS, type QuantumModelName } from '@boardsesh/board-constants/quantum';
import { BluetoothProvider } from './bluetooth-provider';
import { QuantumBluetoothProvider } from './quantum-bluetooth-provider';
import { useActiveBoard } from '../lib/graphql/use-active-board';

/**
 * Web twin of the native BluetoothProviderWrapper. Web Bluetooth
 * (navigator.bluetooth) drives the same Aurora / MoonBoard LED protocol as native
 * through WebBluetoothAdapter, which Metro selects via adapter-factory.web.ts. We
 * mount the real provider so the lightbulb controls appear on the Expo-web build;
 * on browsers without Web Bluetooth (Safari/Firefox) the shared BLE UI surfaces
 * its "Bluetooth unavailable" state on tap, matching native's powered-off path.
 *
 * The provider is mounted unconditionally for the same reason as native: the
 * board from `useActiveBoard` resolves a tick after mount, and keeping a stable
 * element type at this tree position avoids remounting the whole subtree on the
 * `undefined → board` transition. LiveActivityBridge is iOS-native and omitted.
 */
export function BluetoothProviderWrapper({ children }: { children: ReactNode }) {
  const { data: activeBoard } = useActiveBoard();
  const quantumModelId =
    activeBoard?.boardType === 'quantum'
      ? ((Object.entries(QUANTUM_MODELS).find(
          ([, model]) => model.layoutId === activeBoard.layoutId && model.sizeId === activeBoard.sizeId,
        )?.[0] as QuantumModelName | undefined) ?? null)
      : null;
  const legacyActiveBoard = activeBoard?.boardType === 'quantum' ? undefined : activeBoard;

  return (
    <QuantumBluetoothProvider selectedModelId={quantumModelId} preferredSerial={activeBoard?.serialNumber}>
      <BluetoothProvider
        boardName={legacyActiveBoard?.boardType}
        layoutId={legacyActiveBoard?.layoutId}
        sizeId={legacyActiveBoard?.sizeId}
        setIds={legacyActiveBoard?.setIds}
        boardUuid={legacyActiveBoard?.uuid}
      >
        {children}
      </BluetoothProvider>
    </QuantumBluetoothProvider>
  );
}
