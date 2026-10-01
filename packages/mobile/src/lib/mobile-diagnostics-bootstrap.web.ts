import { bootstrapDiagnosticLaunch } from './diagnostic-launch';
import { initializeMobileDiagnostics } from './mobile-diagnostics';

initializeMobileDiagnostics(
  bootstrapDiagnosticLaunch({
    makeId: () => globalThis.crypto.randomUUID(),
    readPrevious: () => null,
    writeCurrent: () => {},
    metadata: {},
  }),
);
