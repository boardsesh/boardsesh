import Foundation

@main enum ClimbOverlayBudgetTests {
  static func main() {
    // Actual iPhone 13 Pro: the heap estimate omits the final 13,176 bytes.
    precondition(ClimbOverlayBudget.allocationSize(requested: 56_822_920,heapSize: 56_822_920,
      heapAlignment: 256,pageSize: 16_384) == 56_836_096,"Reserve the device allocation, including its final page")
    precondition(ClimbOverlayBudget.allocationSize(requested: 1028,heapSize: 1028,
      heapAlignment: 256,pageSize: 16_384) == 16_384,"Small buffers conservatively reserve one page")
    precondition(ClimbOverlayBudget.allocationSize(requested: 16_384,heapSize: 16_384,
      heapAlignment: 256,pageSize: 16_384) == 16_384)
    precondition(ClimbOverlayBudget.allocationSize(requested: 1028,heapSize: 32_769,
      heapAlignment: 32_768,pageSize: 16_384) == 65_536,"Cover the heap estimate and both alignments")
    precondition(ClimbOverlayBudget.allocationSize(requested: 17,heapSize: 17,
      heapAlignment: 12,pageSize: 16) == 48,"Use a common multiple without assuming power-of-two alignment")
    precondition(ClimbOverlayBudget.allocationSize(requested: ClimbOverlayBudget.limit,
      heapSize: ClimbOverlayBudget.limit,heapAlignment: 256,pageSize: 16_384) == ClimbOverlayBudget.limit)
    for invalid in [0,-1,Int.max] {
      precondition(ClimbOverlayBudget.allocationSize(requested: invalid,heapSize: 1028,
        heapAlignment: 256,pageSize: 16_384) == nil)
      precondition(ClimbOverlayBudget.allocationSize(requested: 1028,heapSize: 1028,
        heapAlignment: invalid,pageSize: 16_384) == nil)
      precondition(ClimbOverlayBudget.allocationSize(requested: 1028,heapSize: 1028,
        heapAlignment: 256,pageSize: invalid) == nil)
    }
    precondition(ClimbOverlayBudget.allocationSize(requested: 1028,heapSize: -1,
      heapAlignment: 256,pageSize: 16_384) == nil)
    precondition(ClimbOverlayBudget.allocationSize(requested: 1028,heapSize: Int.max,
      heapAlignment: 256,pageSize: 16_384) == nil)
    precondition(ClimbOverlayBudget.allocationSize(requested: ClimbOverlayBudget.limit,
      heapSize: ClimbOverlayBudget.limit,heapAlignment: 3,pageSize: 16_384) == nil,"Rounding cannot exceed the budget")
    precondition(ClimbOverlayBudget.allocationSize(requested: 1,heapSize: 1,
      heapAlignment: ClimbOverlayBudget.limit-1,pageSize: ClimbOverlayBudget.limit) == nil,"Reject an excessive common multiple")
    let budget = ClimbOverlayBudget()
    var cached: ClimbOverlayBudget.Reservation? = budget.reserve(60 * 1024 * 1024)
    var mountedView = cached
    cached = nil
    precondition(budget.bytes == 60 * 1024 * 1024,"Eviction cannot hide resources retained by a view")
    precondition(budget.reserve(70 * 1024 * 1024) == nil,"Aggregate admission includes mounted views")
    var command = mountedView
    mountedView = nil
    precondition(budget.bytes == 60 * 1024 * 1024,"In-flight GPU commands retain reservations")
    withExtendedLifetime(command) {}
    command = nil
    precondition(budget.bytes == 0)
    var all = budget.reserve(ClimbOverlayBudget.limit)
    precondition(all != nil && budget.reserve(1) == nil)
    precondition(budget.reserve(0) == nil && budget.reserve(-1) == nil)
    withExtendedLifetime(all) {}
    all = nil
    precondition(budget.bytes == 0)
    let observedAllocation = ClimbOverlayBudget.allocationSize(requested: 56_822_920,
      heapSize: 56_822_920,heapAlignment: 256,pageSize: 16_384)!
    var atlasPages = budget.reserve(observedAllocation)
    var retainedPages = atlasPages
    atlasPages = nil
    precondition(budget.bytes == 56_836_096,"A mounted atlas retains its rounded reservation")
    precondition(budget.reserve(ClimbOverlayBudget.limit-observedAllocation+1) == nil,
      "Page padding participates in the aggregate limit")
    withExtendedLifetime(retainedPages) {}
    retainedPages = nil
    precondition(budget.bytes == 0)
    let preparation = ClimbOverlayPreparation()
    precondition(!preparation.isCancelled)
    precondition(preparation.completion(current: true,visible: true) == .accept)
    precondition(preparation.completion(current: false,visible: true) == .superseded)
    precondition(preparation.completion(current: true,visible: false) == .hidden)
    preparation.cancel()
    precondition(preparation.isCancelled)
    precondition(!preparation.retainsCompletedAtlas)
    precondition(preparation.completion(current: true,visible: true) == .cancelled,
      "Reattachment must not turn a cancelled preparation into a render error")
    let detached = ClimbOverlayPreparation()
    detached.cancel(releasingGPU: false)
    precondition(detached.retainsCompletedAtlas,"A completed immutable layout survives presentation-only cancellation")
    var errors = 0
    var retries = 0
    for failed in [false,true] {
      switch detached.completion(current: true,visible: true) {
      case .cancelled,.superseded: retries += 1
      case .hidden: break
      case .accept: if failed { errors += 1 }
      }
    }
    precondition(errors == 0 && retries == 2,"Neither successful nor failed cancelled work reports a failure")
    detached.cancel() // Configuration/background invalidation escalates retention.
    detached.cancel(releasingGPU: false)
    precondition(!detached.retainsCompletedAtlas,"Reattachment cannot undo GPU-release cancellation")
  }
}
