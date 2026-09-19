// Worker threads do not inherit tsx's parent-thread registration.
import { register } from 'tsx/esm/api';
register();
await import('./inference-thread.ts');
