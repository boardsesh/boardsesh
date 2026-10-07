#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runtime overrides for React Native's C++ feature flags (boardsesh/boardsesh#5293).
@interface BoardseshReactFlagOverrides : NSObject

/// Turns on `enableSchedulerDelegateInvalidation` and keeps every other flag at
/// the release level the React Native factory chose.
///
/// Call on the main thread, AFTER `ExpoReactNativeFactory(delegate:)` returns
/// (the factory installs its own provider with `override()`, which throws if a
/// provider is already set) and BEFORE `startReactNative` (the swap destroys
/// the previous flag accessor, which must not be in use on another thread).
/// Calling it more than once is a no-op.
+ (void)install;

/// The value React Native's Scheduler reads. YES once `install` has run.
@property (class, nonatomic, readonly) BOOL schedulerDelegateInvalidationEnabled;

@end

NS_ASSUME_NONNULL_END
