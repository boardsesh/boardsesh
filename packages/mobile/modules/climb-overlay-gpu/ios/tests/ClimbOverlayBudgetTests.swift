import Foundation

@main enum ClimbOverlayBudgetTests {
  static func main() {
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
    let preparation = ClimbOverlayPreparation()
    precondition(!preparation.isCancelled)
    preparation.cancel()
    precondition(preparation.isCancelled)
  }
}
