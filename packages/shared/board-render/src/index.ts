// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

// The barrel intentionally excludes the sharp-dependent `pipeline` module and
// the WASM `wasm` module — import those via `@boardsesh/board-render/pipeline`
// and `@boardsesh/board-render/wasm` so consumers that only need board details
// or validation (e.g. web's board-constants) don't pull sharp into their graph.
export * from './types';
export * from './board-details';
export * from './validation';
export * from './background';
export * from './headers';
export * from './render-config';
export * from './lru';
export * from './semaphore';
