// Keeps expo-file-system download handles reachable from JavaScript until the
// iOS session delegate has finished with them (issue #5297).
//
// WHY THIS EXISTS
//
// `FileSystemDownloadTask.sharedObjectWillRelease()` calls
// `downloadTask?.cancel()` with no completed-task guard (expo-file-system
// 57.0.6, ios/FileSystemDownloadTask.swift:313-316). That pointer is nilled in
// exactly one place for a transfer that ran to completion — `finishTask()`,
// called from `didCompleteWithError`'s `defer` (:406-408 → :308-311/:318-324).
// The promise `downloadAsync()` awaits, however, is resolved earlier, from
// `didFinishDownloadingTo` (:363-404). Between those two delegate callbacks the
// URLSessionTask pointer is live while Foundation is already tearing the task
// down, and cancelling it there is the EXC_BAD_ACCESS of issue #5297.
//
// Dropping our own `task.release()` was necessary but NOT sufficient, because
// `release()` is not the only way into `sharedObjectWillRelease()`. In
// expo-modules-core 57.0.14 the registry wires a releaser into the C++ shared
// object's native state (ios/Core/SharedObjects/SharedObjectRegistry.swift:127-135),
// and `expo::SharedObject::NativeState::~NativeState()` calls it
// (common/cpp/SharedObject.cpp:18-20). The JS object's native-state slot is the
// only strong owner of that C++ state — the Swift side holds the pairing weakly
// (`SharedObject.nativeState` is `weak`; `SharedObjectNativeState.pairedObjects`
// stores `JavaScriptWeakObject`s) — so when Hermes collects the JS handle, the
// destructor runs `SharedObjectRegistry.delete(id)`, which calls
// `sharedObjectWillRelease()`. Same unguarded cancel, same window. Expo
// documents `release()` as doing early what the GC does anyway: "detaches the
// JS and native objects to let the native object deallocate before the JS
// object gets deallocated by the JS garbage collector".
//
// Nothing orders that collection after `didCompleteWithError`. A handle whose
// last JS use was the `await` becomes collectible on the very tick the promise
// settles — the same tick the old eager `release()` fired on. So the fix is to
// keep a strong JS reference until the delegate has certainly moved on.
//
// WHY A TIMER AND WHY THIS LONG
//
// JavaScript gets no signal for `didCompleteWithError`; expo exposes no
// completion event, only `progress` (expo-file-system 57.0.6,
// src/NetworkTasks.ts). What we need to outlast is one hop on the URLSession
// delegate queue: `didCompleteWithError` is the next callback that queue runs
// after `didFinishDownloadingTo` returns, with no work in between.
// DOWNLOAD_TASK_RETENTION_MS is roughly four orders of magnitude more than that
// hop, and holding a pointer-sized shell object for that long costs nothing —
// the ~100 MB payload went straight to disk, never through this handle.
//
// The deterministic alternative is a native completed-task guard in
// expo-file-system, which cannot be done in JavaScript: patching Swift moves
// the fingerprint, so it would never reach the store builds the crashes are
// coming from.

/**
 * How long a handle stays reachable after its transfer settles. See the header
 * for why the delegate-queue hop this has to outlast is measured in
 * microseconds.
 */
export const DOWNLOAD_TASK_RETENTION_MS = 30_000;

/**
 * The handles JavaScript still references, mapped to the timer that will drop
 * them (`null` while the transfer is still running, so an in-flight handle is
 * never evicted). Both the map key and the timer closure hold the handle
 * strongly, which is the entire point: while it is in here, Hermes cannot
 * collect it and `~NativeState()` cannot run.
 *
 * Keys are compared by identity, so a handle is only ever released by the
 * transfer that retained it.
 */
const retainedDownloadTasks = new Map<object, ReturnType<typeof setTimeout> | null>();

/**
 * Pins `task` so the garbage collector cannot reach
 * `sharedObjectWillRelease()`. Call it as soon as the handle exists — a
 * collection mid-transfer would cancel a live download as well as risking the
 * teardown window.
 */
export function retainDownloadTask(task: object): void {
  if (retainedDownloadTasks.has(task)) return;
  retainedDownloadTasks.set(task, null);
}

/**
 * Starts the countdown that lets `task` become collectible again. Call it once
 * the transfer has settled, whether it produced a file or threw: the error path
 * settles from `didCompleteWithError` itself, whose `promise.reject(...)` runs
 * BEFORE the `defer { finishTask() }` that clears the pointer, so it sits in
 * the same window.
 *
 * By the time the timer fires, `didCompleteWithError` has long since nilled
 * `downloadTask`, so the collection that eventually follows finds nothing to
 * cancel.
 */
export function releaseDownloadTaskAfterNativeCompletion(task: object): void {
  if (!retainedDownloadTasks.has(task)) return;
  if (retainedDownloadTasks.get(task) !== null) return;
  retainedDownloadTasks.set(
    task,
    setTimeout(() => {
      retainedDownloadTasks.delete(task);
    }, DOWNLOAD_TASK_RETENTION_MS),
  );
}

/**
 * Whether JavaScript still holds `task`, and so whether a Hermes collection
 * could currently run `sharedObjectWillRelease()` on it.
 *
 * The app never needs to ask; the snapshot-source suite does, to model GC
 * finalization of an unreferenced handle at the exact moment the window is
 * open. Without a reachability query a test can only fake the collection, which
 * proves nothing about whether the app prevented it.
 */
export function isDownloadTaskRetained(task: object): boolean {
  return retainedDownloadTasks.has(task);
}

/**
 * Drops every handle and cancels the pending releases, so one test's retained
 * handles and 30-second timers cannot leak into the next. Production code has
 * no reason to call this: a handle released early is exactly the crash.
 */
export function clearRetainedDownloadTasks(): void {
  for (const timer of retainedDownloadTasks.values()) {
    if (timer !== null) clearTimeout(timer);
  }
  retainedDownloadTasks.clear();
}
