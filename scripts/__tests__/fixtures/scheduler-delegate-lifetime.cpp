#include <atomic>
#include <functional>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

namespace folly { using dynamic = std::string; }
namespace facebook::react {
struct TraceSection {
  template <typename... Arguments> explicit TraceSection(Arguments&&...) {}
};
struct MountingCoordinator { int getSurfaceId() const { return 1; } };
struct ShadowNode { int getSurfaceId() const { return 1; } };
struct ShadowView { explicit ShadowView(const ShadowNode&) {} };
struct SchedulerDelegate {
  int transactions = 0;
  int commands = 0;
  void schedulerDidFinishTransaction(std::shared_ptr<const MountingCoordinator>) {}
  void schedulerShouldRenderTransactions(std::shared_ptr<const MountingCoordinator>) { transactions++; }
  void schedulerDidDispatchCommand(const ShadowView&, const std::string&, const folly::dynamic&) { commands++; }
};
struct RuntimeScheduler {
  std::vector<std::function<void()>> queue;
  void scheduleRenderingUpdate(int, std::function<void()> callback) { queue.push_back(std::move(callback)); }
  void drain() { auto pending = std::move(queue); queue.clear(); for (auto& callback : pending) callback(); }
};
class Scheduler {
 public:
  Scheduler(RuntimeScheduler* runtimeScheduler, SchedulerDelegate* delegate)
      : delegate_(delegate), delegateInvalidated_(std::make_shared<std::atomic<bool>>(false)),
        runtimeScheduler_(runtimeScheduler) {}
  ~Scheduler() { /* INSERT_DESTRUCTOR_INVALIDATION */ }
  void setDelegate(SchedulerDelegate* delegate);
  void uiManagerDidFinishTransaction(std::shared_ptr<const MountingCoordinator> mountingCoordinator, bool mountSynchronously);
  void uiManagerDidDispatchCommand(const std::shared_ptr<const ShadowNode>& shadowNode, const std::string& commandName, const folly::dynamic& args);
 private:
  SchedulerDelegate* delegate_;
  std::shared_ptr<std::atomic<bool>> delegateInvalidated_;
  RuntimeScheduler* runtimeScheduler_;
};

// INSERT_INSTALLED_METHODS

void enqueue(Scheduler& scheduler) {
  scheduler.uiManagerDidFinishTransaction(std::make_shared<MountingCoordinator>(), false);
  scheduler.uiManagerDidDispatchCommand(std::make_shared<ShadowNode>(), "focus", "");
}

int exercise(const std::string& scenario) {
  RuntimeScheduler runtime;
  SchedulerDelegate original;
  SchedulerDelegate replacement;
  auto scheduler = std::make_unique<Scheduler>(&runtime, &original);
  enqueue(*scheduler);
  if (scenario == "replacement") {
    scheduler->setDelegate(&replacement);
    enqueue(*scheduler);
    runtime.drain();
    if (original.transactions || original.commands || replacement.transactions != 1 || replacement.commands != 1) return 1;
  } else if (scenario == "null") {
    scheduler->setDelegate(nullptr);
    runtime.drain();
    if (original.transactions || original.commands) return 1;
  } else if (scenario == "destruction") {
    scheduler.reset();
    runtime.drain();
    if (original.transactions || original.commands) return 1;
  } else if (scenario == "same-delegate") {
    scheduler->setDelegate(&original);
    runtime.drain();
    if (original.transactions != 1 || original.commands != 1) return 1;
  } else if (scenario == "synchronous") {
    scheduler->uiManagerDidFinishTransaction(std::make_shared<MountingCoordinator>(), true);
    if (original.transactions != 1) return 1;
    scheduler->setDelegate(nullptr);
    runtime.drain();
    if (original.transactions != 1 || original.commands != 0) return 1;
  } else return 1;
  return 0;
}
} // namespace facebook::react

int main(int count, char** arguments) {
  if (count != 2 || facebook::react::exercise(arguments[1]) != 0) return 1;
  std::cout << "PASS " << arguments[1] << std::endl;
}
