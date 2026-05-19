'use client';

import { useSyncExternalStore } from 'react';

/**
 * Module-level store that tracks whether any mounted `BluetoothProvider`
 * currently has a live connection. This lets consumers rendered outside
 * any `BluetoothProvider` (e.g., the root bottom tab bar) observe BT
 * connection state without requiring the provider to be an ancestor.
 *
 * The store is updated from `BluetoothProvider` via `setBluetoothConnected`.
 */

let connectedCount = 0;
const listeners = new Set<() => void>();
const activeDisconnects = new Set<() => void>();
/**
 * Optional callback registered by the active `BluetoothProvider` that knows
 * how to re-send the user's current local pick via BLE. Used by
 * `useSendLocalPick()` so the manual "Send your pick" CTA in the play-view
 * drawer header can drive a send without needing to live inside the
 * BluetoothProvider tree (the queue drawer mounts at the root level).
 *
 * `null` when no provider is mounted with an active connection.
 */
let activeManualSender: ManualSender | null = null;

/**
 * Returns whether the send was accepted by the BLE pipe. Resolves to `false`
 * when there's no local pick to send or when the underlying write fails.
 */
export type ManualSender = () => Promise<boolean>;

/** BLE serial reported by the active `BluetoothProvider`, if any. Mirrors the
 * `connectedSerial` exposed by `useBluetoothContext()` but is readable from
 * any component (the BoardHistoryProvider mounts above BluetoothProvider in
 * the tree, so it can't use the context hook). Null when no aurora board is
 * connected. */
let activeSerial: string | null = null;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return connectedCount > 0;
}

function getServerSnapshot(): boolean {
  return false;
}

function getSerialSnapshot(): string | null {
  return activeSerial;
}

function getSerialServerSnapshot(): string | null {
  return null;
}

/**
 * Register a live Bluetooth connection along with its `disconnect`
 * function. Called from `BluetoothProvider` whenever `isConnected`
 * flips to `true`. Returns a cleanup function to call when it flips
 * back to `false` or the provider unmounts.
 */
export function registerBluetoothConnection(disconnect: () => void): () => void {
  connectedCount += 1;
  activeDisconnects.add(disconnect);
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    connectedCount = Math.max(0, connectedCount - 1);
    activeDisconnects.delete(disconnect);
    notify();
  };
}

/**
 * Publish the BLE serial of the currently-connected controller. Called by
 * `BluetoothProvider` from a sync effect whenever `connectedSerial` changes.
 * Pass `null` to clear (on disconnect or when no controller is present).
 * Consumers should read via `useBluetoothConnectedSerial()`.
 */
export function setActiveBluetoothSerial(serial: string | null): void {
  if (activeSerial === serial) return;
  activeSerial = serial;
  notify();
}

/**
 * Disconnect any and all currently-registered Bluetooth connections.
 * Used by the board-switch guard to drop hardware connections before
 * navigating to a different board.
 */
export function disconnectAllBluetooth(): void {
  // Snapshot first — disconnect() typically triggers the cleanup
  // function which mutates activeDisconnects during iteration.
  const snapshot = Array.from(activeDisconnects);
  for (const disconnect of snapshot) {
    try {
      disconnect();
    } catch (err) {
      console.error('Failed to disconnect bluetooth:', err);
    }
  }
}

/**
 * Hook returning `true` when any BluetoothProvider reports an active
 * connection. Works from any component in the tree.
 */
export function useBluetoothConnectedStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Register a manual-send callback exposed by `BluetoothProvider`. Called by
 * the active provider when it mounts; returns a release function the
 * provider calls on unmount (or when its sender identity changes) so a
 * stale closure doesn't drive a future send.
 *
 * Only one sender can be active at a time — the latest registration wins.
 * In practice only one `BluetoothProvider` is mounted at any moment (the
 * board route renders it; switching boards tears the old provider down
 * before the new one mounts), so this is enough.
 */
export function registerManualSender(sender: ManualSender): () => void {
  activeManualSender = sender;
  return () => {
    if (activeManualSender === sender) {
      activeManualSender = null;
    }
  };
}

/**
 * Invoke the registered manual sender. Returns `false` when nothing is
 * registered (no BluetoothProvider is mounted with a sender). Consumers
 * that care about the outcome should check the resolved boolean.
 */
export function triggerManualSend(): Promise<boolean> {
  if (!activeManualSender) return Promise.resolve(false);
  return activeManualSender();
}

/**
 * Hook returning the BLE serial of the currently-connected controller, or
 * `null` when no aurora controller is connected. Works from any component
 * in the tree — the BoardHistoryProvider relies on this because it mounts
 * above the per-route BluetoothProvider in the React tree.
 */
export function useBluetoothConnectedSerial(): string | null {
  return useSyncExternalStore(subscribe, getSerialSnapshot, getSerialServerSnapshot);
}
