import Foundation

/// Reservations follow retained resources, rather than the cache entry. A
/// view and its outstanding command buffers can outlive cache eviction.
final class ClimbOverlayBudget {
  static let limit = 128 * 1024 * 1024
  private let lock = NSLock()
  private var resident = 0

  var bytes: Int { lock.lock(); defer { lock.unlock() }; return resident }

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
  private let lock = NSLock()
  private var cancelled = false
  var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
  func cancel() { lock.lock(); cancelled = true; lock.unlock() }
}
