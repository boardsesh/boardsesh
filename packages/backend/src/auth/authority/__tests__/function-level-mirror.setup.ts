import { recordFunctionLevelIdentityMirrorForTests } from '../mirror-activation';

// These suites exercise writers with AUTH_IDENTITY_MIRROR=on without booting the
// backend. Outside a test, a mirror that never qualified at startup refuses every
// copy (MIRROR_NOT_QUALIFIED); identity-import.proof.ts covers that path and loads
// no setup file.
recordFunctionLevelIdentityMirrorForTests();
