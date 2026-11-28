// "Scan a board code", pushed from the wizard's "Whose board?" step. The
// screen, and why expo-camera is reached only through a guard, is in
// src/components/board-code-scanner/BoardCodeScannerScreen.tsx.

import { BoardCodeScannerScreen } from '../../../src/components/board-code-scanner/BoardCodeScannerScreen';

export default function AddBoardScan() {
  return <BoardCodeScannerScreen />;
}
