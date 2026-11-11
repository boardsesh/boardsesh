// Imported by src/index.ts straight after ./instrument, before any module that
// builds a Postgres pool. Every pool this process builds then ends a session
// left idle inside a transaction (docs/db-connectivity.md, "Idle transactions
// end after 60 s on request pools"). Workers and scripts have their own entry
// points and never import this file.
import { applyRequestPoolDefaults } from '@boardsesh/db/client';

applyRequestPoolDefaults();
