import { describe, expect, it } from 'vitest';
import * as portable from '@boardsesh/quantum-ble-protocol';
import * as compatibility from '../quantum';

// Every runtime export `@boardsesh/ble-protocol/quantum` had before the codec and
// transaction machine moved to `@boardsesh/quantum-ble-protocol`. The protocol
// tests moved with the code; this file pins the compatibility surface only.
const PRE_EXTRACTION_RUNTIME_EXPORTS = [
  'QUANTUM_ATT_HEADER_BYTES',
  'QUANTUM_BOARD_MODELS',
  'QUANTUM_DEFAULT_ROUTE_DURATION_SECONDS',
  'QUANTUM_DEVICE_NAME_PREFIXES',
  'QUANTUM_LEGACY_SERVICE_UUID',
  'QUANTUM_MAX_DIODE_IDS',
  'QUANTUM_MAX_PLAYERS',
  'QUANTUM_METADATA_CHARACTERISTIC_UUID',
  'QUANTUM_MODELS',
  'QUANTUM_NOTIFY_CHARACTERISTIC_UUID',
  'QUANTUM_REQUESTED_MTU',
  'QUANTUM_SERVICE_UUID',
  'QUANTUM_SERVICE_UUIDS',
  'QUANTUM_STATE_CHARACTERISTIC_UUID',
  'QUANTUM_WRITE_CHARACTERISTIC_UUID',
  'QUANTUM_ZERO_UUID',
  'QuantumCommand',
  'QuantumRosterTransactionError',
  'QuantumRosterTransactionMachine',
  'assertQuantumWriteEligible',
  'decodeQuantumUuid',
  'encodeQuantumActivation',
  'encodeQuantumRosterRequest',
  'encodeQuantumTurnOffAll',
  'encodeQuantumTurnOffRoute',
  'encodeQuantumTurnOffUser',
  'encodeQuantumTurnOnAll',
  'encodeQuantumUuid',
  'parseQuantumBroadcast',
  'parseQuantumControllerMetadata',
  'parseQuantumDeviceSerial',
  'quantumAttPayloadBytes',
  'quantumBroadcastLength',
  'quantumControllerFailureFromCode',
  'quantumCrc16Modbus',
  'quantumFrameFitsMtu',
  'quantumFrameHasValidCrc',
  'quantumRostersEqual',
  'quantumUuidsEqual',
] as const;

describe('Quantum compatibility surface', () => {
  it('re-exports exactly the pre-extraction runtime names, and no session API', () => {
    expect(Object.keys(compatibility).sort()).toEqual([...PRE_EXTRACTION_RUNTIME_EXPORTS].sort());
  });

  it('re-exports the portable bindings themselves, so instanceof and identity checks still hold', () => {
    for (const name of PRE_EXTRACTION_RUNTIME_EXPORTS) expect(compatibility[name]).toBe(portable[name]);
  });
});
