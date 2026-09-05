#!/usr/bin/env node

// Workspace binaries must exist before any build runs.
import { register } from 'tsx/esm/api';

register();
await import('../src/cli.ts');
