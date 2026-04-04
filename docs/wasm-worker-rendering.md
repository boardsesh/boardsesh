# WASM Web Worker Rendering Architecture

This document describes the board rendering pipeline used in Boardsesh. The system progressively upgrades from server-rendered image layers to a client-side Web Worker pipeline that composites board overlays using WebAssembly on OffscreenCanvas.

## Table of Contents

1. [Rendering Tiers](#rendering-tiers)
2. [Renderer Modes](#renderer-modes)
3. [Architecture Overview](#architecture-overview)
4. [Rendering Flow](#rendering-flow)
5. [Worker Pool](#worker-pool)
6. [Caching and Deduplication](#caching-and-deduplication)
7. [Background Image Preloading](#background-image-preloading)
8. [Browser Support](#browser-support)
9. [Error Handling and Fallbacks](#error-handling-and-fallbacks)
10. [Key Files](#key-files)

---

## Rendering Tiers

The board rendering pipeline has two active tiers:

| Tier            | Component             | Rendering Method                                  | When Used                                        |
| --------------- | --------------------- | ------------------------------------------------- | ------------------------------------------------ |
| 1 (server WASM) | `BoardImageLayers`    | `<img>` overlay from `/api/internal/board-render` | SSR fallback before the worker is ready          |
| 2 (client WASM) | `BoardCanvasRenderer` | OffscreenCanvas in Web Worker                     | After hydration, when the canvas worker is ready |

`BoardCanvasRenderer` always uses `BoardImageLayers` as its SSR fallback.

---

## Renderer Modes

The rollout flags have been removed. The supported behavior is:

- Server render with `BoardImageLayers`
- Upgrade to `BoardCanvasRenderer` after hydration when the worker pool is ready
- Fall back to `BoardImageLayers` on clients that are not ready yet

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Server (SSR)                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  Page Component                                                          │
│    └── BoardImageLayers                                                  │
│          ├── <img> background (static board image)                       │
│          └── <img> overlay (from /api/internal/board-render)             │
│                                    │                                     │
│                                    ▼                                     │
│                     ┌──────────────────────────┐                         │
│                     │ /api/internal/board-render│                         │
│                     │ WASM module (server-side) │                         │
│                     │ Generates PNG overlay     │                         │
│                     └──────────────────────────┘                         │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   │ HTML sent to client
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Client (after hydration)                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  BoardCanvasRenderer                                                     │
│    ├── <canvas> (visible, receives ImageBitmap from worker)              │
│    └── useCanvasRendererReady (flips when worker pool is initialized)    │
│                                                                          │
│  ┌───────────────────────────────────────────────────┐                   │
│  │              Main Thread                           │                   │
│  │  WorkerManager                                     │                   │
│  │    ├── LRU bitmap cache (50 entries)               │                   │
│  │    ├── Request deduplication                        │                   │
│  │    ├── Round-robin worker dispatch                  │                   │
│  │    └── Background image preloading                  │                   │
│  └──────────────┬────────────────────────────────────┘                   │
│                 │ postMessage (render request)                            │
│                 │ transferable ImageBitmap back                           │
│    ┌────────────┼────────────┬────────────┐                              │
│    ▼            ▼            ▼            ▼                               │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐                                │
│  │Worker│  │Worker│  │Worker│  │Worker│  ...                            │
│  │  #1  │  │  #2  │  │  #3  │  │  #4  │                                │
│  │ WASM │  │ WASM │  │ WASM │  │ WASM │                                │
│  └──────┘  └──────┘  └──────┘  └──────┘                                │
│  Each worker loads WASM from /public/wasm/                               │
│  and composites background + overlay on OffscreenCanvas                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Rendering Flow

### 1. Server-Side Render

The page component renders `BoardImageLayers`, which produces two `<img>` tags:

- A background image (the static board photo).
- An overlay image, with `src` pointing to `/api/internal/board-render`. This API route runs the WASM module server-side to generate a PNG of the hold circles for the current climb.

This HTML is sent to the client. The user sees a fully rendered board before any JavaScript executes.

### 2. Client Hydration

React hydrates `BoardImageLayers`. The DOM matches the server-rendered HTML, so no layout shift occurs.

### 3. Worker Takeover

After mount, `useCanvasRendererReady` resolves to `true` once the browser supports `OffscreenCanvas` and the worker pool is initialized. `BoardCanvasRenderer` replaces `BoardImageLayers` in the visible layout.

A module-level `globalCanvasReady` flag ensures that only the first batch of component instances goes through the `false`→`true` transition. Subsequent instances (e.g. from infinite scroll) initialise with `true` immediately, avoiding a one-frame flash of `BoardImageLayers` and the API request it would trigger.

1. `BoardCanvasRenderer` sends a render request to the `WorkerManager`.
2. The `WorkerManager` checks the LRU cache. On a cache hit, it returns the cached `ImageBitmap` immediately.
3. On a cache miss, the request is dispatched to the next worker in the round-robin rotation.
4. The worker receives the request, composites the background image with the WASM-generated overlay on an `OffscreenCanvas`, and transfers the resulting `ImageBitmap` back to the main thread.
5. The main thread caches the bitmap and draws it on the visible `<canvas>`.

### 4. Subsequent Renders

When the user navigates to a different climb, the same flow repeats from step 1 of the worker takeover. Identical board+frame combinations are deduplicated -- if a request for the same parameters is already in flight, the new caller receives the same promise rather than dispatching a duplicate render.

---

## Worker Pool

The `WorkerManager` maintains a pool of Web Workers, each running its own instance of the WASM module.

| Environment       | Worker Count |
| ----------------- | ------------ |
| Browser           | 3            |
| Capacitor WebView | 5            |

Workers are allocated by round-robin. Each worker loads the WASM module from `/public/wasm/` on initialization. The pool is created once and reused for the lifetime of the page.

---

## Caching and Deduplication

### LRU Bitmap Cache

The main thread maintains an LRU cache of 50 `ImageBitmap` entries, keyed by the combination of board configuration and frame parameters. Cache hits skip the worker entirely and return the bitmap synchronously.

### Request Deduplication

If a render request arrives for parameters that match an in-flight request, the `WorkerManager` does not dispatch a second job. Instead, the new caller shares the promise of the existing request. This prevents redundant work when multiple components request the same render simultaneously (e.g., during rapid navigation).

---

## Background Image Preloading

Board background images (the static board photos) are fetched once on the main thread and transferred to all workers. This avoids each worker independently fetching the same image over the network:

1. The main thread fetches the background image and converts it to an `ImageBitmap`.
2. The bitmap is transferred to each worker via `postMessage` with transferable objects.
3. Workers store the bitmap and use it for all subsequent compositing operations.

---

## Browser Support

| Feature         | Minimum Version                        |
| --------------- | -------------------------------------- |
| OffscreenCanvas | Safari 16.4+, Chrome 69+, Firefox 105+ |
| Web Workers     | All modern browsers                    |
| WebAssembly     | All modern browsers                    |

If `OffscreenCanvas` is unavailable, the system stays on `BoardImageLayers` (Tier 2). The `BoardCanvasRenderer` component checks for `OffscreenCanvas` support before attempting to initialize the worker pool.

---

## Error Handling and Fallbacks

### Worker Errors

When a worker encounters an error (via `onerror`), only the pending requests assigned to that specific worker are rejected. Other workers in the pool continue operating normally. The pool does not collapse on a single worker failure.

### Render Failures

If `BoardCanvasRenderer` fails to produce a frame (worker error, WASM crash, or any unhandled exception), it falls back to rendering `BoardImageLayers`. This fallback is per-instance -- one component failing does not affect others.

### Image Preload Failures

If a background image fails to load during preloading, the error is logged but does not block the rendering pipeline. Workers that did not receive the background image skip the compositing step for that layer.

---

## Key Files

| File                                                                   | Purpose                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/web/app/lib/board-render-worker/worker-manager.ts`           | Worker pool lifecycle, LRU cache, request deduplication, background image preloading |
| `packages/web/app/lib/board-render-worker/board-render.worker.ts`      | Worker code: WASM loading, OffscreenCanvas compositing, message handling             |
| `packages/web/app/components/board-renderer/board-canvas-renderer.tsx` | Client-side canvas renderer component, error fallback to BoardImageLayers            |
| `packages/web/app/components/board-renderer/board-image-layers.tsx`    | Server-rendered image layer component (Tier 2)                                       |
| `packages/web/app/api/internal/board-render/route.ts`                  | Server-side WASM API route, generates PNG overlay                                    |
| `packages/web/app/flags.ts`                                            | Empty feature flag placeholder kept for future flags                                 |
