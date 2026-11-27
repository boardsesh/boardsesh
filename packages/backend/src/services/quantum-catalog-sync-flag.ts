import { createSystemServerFlag } from './system-server-flag';

export const quantumCatalogSyncFlag = createSystemServerFlag({
  flagKey: 'quantum-catalog-sync',
  logLabel: 'QuantumSync',
  outageConsequence: 'catalogue sync stays off until it answers',
  booleanOnly: true,
});
