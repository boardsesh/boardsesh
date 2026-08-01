import Foundation

/// Generic async-waiter pool. Each `wait(timeout:isReady:)` call suspends
/// until either `signalAll()` resumes pending waiters or the per-waiter
/// timeout elapses, whichever comes first.
///
/// All state mutation runs on the pool's serial `queue`, so the pool inherits
/// the queue's serial ordering — there's no internal locking. Callers must
/// invoke `signalAll()` and read `hasPendingWaiters` from that queue too.
///
/// Extracted from `BoardBleManager` so the waiter timing logic can be unit
/// tested without standing up a real `CBCentralManager`.
///
/// `@unchecked Sendable`: every mutation of `waiters` happens on `queue`,
/// which is a serial `DispatchQueue`. There's no shared concurrent access
/// to the array, but the compiler can't see that — hence unchecked.
final class WaiterPool: @unchecked Sendable {
    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<Bool, Never>
        let timeoutWorkItem: DispatchWorkItem
    }

    private let queue: DispatchQueue
    private var waiters: [Waiter] = []

    init(queue: DispatchQueue) {
        self.queue = queue
    }

    /// Returns `true` immediately when `isReady()` is already satisfied, or
    /// after `signalAll()` resumes the waiter. Returns `false` when `timeout`
    /// elapses first.
    func wait(timeout: TimeInterval, isReady: @escaping () -> Bool) async -> Bool {
        await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            queue.async { [weak self] in
                guard let self else {
                    continuation.resume(returning: false)
                    return
                }
                if isReady() {
                    continuation.resume(returning: true)
                    return
                }
                let waiterId = UUID()
                let workItem = DispatchWorkItem { [weak self] in
                    guard let self else {
                        // Pool was deallocated between wait() enqueueing the
                        // waiter and the timeout firing. The Waiter struct
                        // (along with its continuation reference inside the
                        // pool's array) is gone, so resume the captured
                        // continuation directly — leaking a CheckedContinuation
                        // traps in debug builds and hangs the awaiting Task.
                        // In practice unreachable while BoardBleManager.shared
                        // owns the pool, but the contract has to hold.
                        continuation.resume(returning: false)
                        return
                    }
                    if let index = self.waiters.firstIndex(where: { $0.id == waiterId }) {
                        let waiter = self.waiters.remove(at: index)
                        waiter.continuation.resume(returning: false)
                    }
                    // If no matching waiter is found, signalAll already
                    // resumed this continuation and removed the entry — do
                    // nothing (double-resume would trap).
                }
                self.waiters.append(
                    Waiter(id: waiterId, continuation: continuation, timeoutWorkItem: workItem)
                )
                self.queue.asyncAfter(deadline: .now() + timeout, execute: workItem)
            }
        }
    }

    /// Resumes every currently pending waiter and cancels their pending
    /// timeout work items. Must be invoked from the pool's queue.
    func signalAll() {
        let snapshot = waiters
        waiters = []
        for waiter in snapshot {
            waiter.timeoutWorkItem.cancel()
            waiter.continuation.resume(returning: true)
        }
    }

    /// `true` while at least one continuation is suspended. Must be read on
    /// the pool's queue.
    var hasPendingWaiters: Bool {
        !waiters.isEmpty
    }
}
