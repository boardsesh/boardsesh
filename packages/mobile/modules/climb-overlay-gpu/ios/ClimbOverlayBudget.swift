import Foundation

let climbOverlayAggregateBudget = ClimbOverlayBudget()

/// Reservations follow retained resources, rather than the cache entry. A
/// view and its outstanding command buffers can outlive cache eviction.
final class ClimbOverlayBudget {
  static let limit = ClimbOverlayPacketLayout.maxGpuBytes
  private let lock = NSLock()
  private var resident = 0

  var bytes: Int { lock.lock(); defer { lock.unlock() }; return resident }

  /// Shared buffers can occupy whole VM pages even when Metal's heap estimate
  /// reports only their requested length. Admission must cover that allocation.
  static func allocationSize(requested: Int, heapSize: Int, heapAlignment: Int,
                             pageSize: Int = Int(getpagesize())) -> Int? {
    let required = max(requested,heapSize)
    guard requested > 0,heapSize >= 0,required <= limit,
      heapAlignment > 0,heapAlignment <= limit,pageSize > 0,pageSize <= limit else { return nil }
    var divisor = pageSize
    var remainder = heapAlignment
    while remainder != 0 {
      let next = divisor % remainder
      divisor = remainder
      remainder = next
    }
    let pagesPerAlignment = pageSize / divisor
    guard pagesPerAlignment <= limit / heapAlignment else { return nil }
    let alignment = pagesPerAlignment * heapAlignment
    let padding = (alignment - required % alignment) % alignment
    guard required <= limit - padding else { return nil }
    return required + padding
  }

  func reserve(_ amount: Int) -> Reservation? {
    lock.lock()
    defer { lock.unlock() }
    guard amount > 0, amount <= Self.limit - resident else { return nil }
    resident += amount
    return Reservation(budget: self, amount: amount)
  }

  private func release(_ amount: Int) {
    lock.lock()
    defer { lock.unlock() }
    precondition(amount > 0 && amount <= resident)
    resident -= amount
  }

  final class Reservation {
    private let budget: ClimbOverlayBudget
    private let amount: Int
    fileprivate init(budget: ClimbOverlayBudget, amount: Int) {
      self.budget = budget
      self.amount = amount
    }
    deinit { budget.release(amount) }
  }
}

/// Main-thread prop changes can cancel queued preparations safely.
final class ClimbOverlayPreparation {
  enum Completion: Equatable { case cancelled, superseded, hidden, accept }
  private let lock = NSLock()
  private var cancelled = false
  private var discardCompletedAtlas = false
  private let cancelAction: (() -> Void)?
  init(cancelAction: (() -> Void)? = nil) { self.cancelAction = cancelAction }
  var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
  var retainsCompletedAtlas: Bool {
    lock.lock(); defer { lock.unlock() }
    return cancelled && !discardCompletedAtlas
  }
  /// Detachment invalidates presentation, not a completed immutable layout.
  /// Configuration changes/backgrounding may escalate cancellation to release
  /// GPU resources; later presentation-only cancellation cannot undo that.
  func cancel(releasingGPU: Bool = true) {
    lock.lock()
    let signal = !cancelled
    cancelled = true
    discardCompletedAtlas = discardCompletedAtlas || releasingGPU
    lock.unlock()
    if signal { cancelAction?() }
  }
  func completion(current: Bool, visible: Bool) -> Completion {
    if isCancelled { return .cancelled }
    if !current { return .superseded }
    return visible ? .accept : .hidden
  }
}
