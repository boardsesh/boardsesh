#import "BoardseshReactFlagOverrides.h"

#include <memory>
#include <optional>
#include <string>

#include <react/featureflags/ReactNativeFeatureFlags.h>
#include <react/featureflags/ReactNativeFeatureFlagsOverridesOSSCanary.h>
#include <react/featureflags/ReactNativeFeatureFlagsOverridesOSSExperimental.h>
#include <react/featureflags/ReactNativeFeatureFlagsOverridesOSSStable.h>

// boardsesh/boardsesh#5293 (Sentry BOARDSESH-8S).
//
// react-native 0.86.3's Scheduler queues rendering updates holding a raw
// SchedulerDelegate*. Its only protection is an invalidation token that
// ~Scheduler and setDelegate() arm ONLY when enableSchedulerDelegateInvalidation
// is true, and every OSS release level except Experimental ships it false. When
// RCTScheduler's dealloc drops the delegate (iOS terminating a backgrounded app,
// or an expo-updates reload), the queued lambda then drains through freed
// memory on the JS thread.
//
// iOS links Meta's prebuilt React.xcframework, so a source patch to the
// defaults header is never compiled. The flag is read through a virtual
// provider, though, so installing a provider at runtime works against the
// prebuilt core.
//
// Why dangerouslyForceOverride and not override(): RCTReactNativeFactory's
// init already calls ReactNativeFeatureFlags::override() once (under
// dispatch_once), and a second override() throws. dangerouslyForceOverride
// swaps in a fresh accessor holding our provider. It also frees the old
// accessor without a lock, so it must run before any other thread reads a flag.
// That is why the AppDelegate calls it between the factory init and
// startReactNative: no RCTHost, JS thread or Scheduler exists yet.

using namespace facebook::react;

namespace {

template <typename ReleaseLevelOverrides>
class WithSchedulerDelegateInvalidation final : public ReleaseLevelOverrides {
 public:
  bool enableSchedulerDelegateInvalidation() override
  {
    return true;
  }
};

// Mirrors ExpoReactNativeFactory's release-level lookup (Info.plist
// ReactNativeReleaseLevel, default Stable), so every other flag keeps the value
// the factory's own provider gave it.
std::unique_ptr<ReactNativeFeatureFlagsProvider> makeProvider()
{
  id configured = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"ReactNativeReleaseLevel"];
  NSString *releaseLevel = [configured isKindOfClass:[NSString class]] ? [(NSString *)configured lowercaseString] : nil;

  if ([releaseLevel isEqualToString:@"canary"]) {
    return std::make_unique<WithSchedulerDelegateInvalidation<ReactNativeFeatureFlagsOverridesOSSCanary>>();
  }
  if ([releaseLevel isEqualToString:@"experimental"]) {
    return std::make_unique<WithSchedulerDelegateInvalidation<ReactNativeFeatureFlagsOverridesOSSExperimental>>();
  }
  return std::make_unique<WithSchedulerDelegateInvalidation<ReactNativeFeatureFlagsOverridesOSSStable>>();
}

} // namespace

@implementation BoardseshReactFlagOverrides

+ (void)install
{
  NSAssert([NSThread isMainThread], @"BoardseshReactFlagOverrides.install() must run on the main thread");

  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    std::optional<std::string> readBeforeSwap = ReactNativeFeatureFlags::dangerouslyForceOverride(makeProvider());
    BOOL enabled = ReactNativeFeatureFlags::enableSchedulerDelegateInvalidation();

    if (!enabled) {
      NSLog(@"[BoardseshReactFlagOverrides] ERROR: enableSchedulerDelegateInvalidation is still false after the override (#5293)");
    }
#if DEBUG
    NSLog(
        @"[BoardseshReactFlagOverrides] enableSchedulerDelegateInvalidation=%@; flags read before the swap: %s",
        enabled ? @"true" : @"false",
        readBeforeSwap.has_value() ? readBeforeSwap->c_str() : "none");
    NSAssert(enabled, @"enableSchedulerDelegateInvalidation override did not take effect (#5293)");
#endif
  });
}

+ (BOOL)schedulerDelegateInvalidationEnabled
{
  return ReactNativeFeatureFlags::enableSchedulerDelegateInvalidation();
}

@end
