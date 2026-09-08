import type { ReactNode } from 'react';
import { BluetoothProvider } from './bluetooth-provider';
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

  return (
    <BluetoothProvider
      boardName={activeBoard?.boardType}
      layoutId={activeBoard?.layoutId}
      sizeId={activeBoard?.sizeId}
      setIds={activeBoard?.setIds}
      boardUuid={activeBoard?.uuid}
      hasLeds={activeBoard?.hasLeds}
    >
      {children}
    </BluetoothProvider>
  );
}
