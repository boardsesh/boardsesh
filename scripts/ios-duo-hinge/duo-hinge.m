// Folds and unfolds the iPhone Duo simulator without Device Hub.
//
// Xcode 27 has no simctl command for the Duo's hinge. SpringBoard does have a
// test service for it (SBSDisplayToolService, "com.apple.springboard.sbdisplay"),
// but it refuses every client without a private entitlement, and the simulator
// refuses to spawn an ad-hoc binary that carries one. So this library is loaded
// INTO the simulator's SpringBoard (DYLD_INSERT_LIBRARIES through the
// simulator's launchctl, then a SpringBoard restart; see
// scripts/lib/ios-duo-hinge.ts) and calls the service's coordinator directly.
//
// Interface: `notifyutil -p com.boardsesh.duo-hinge.swap` inside the simulator
// runs one synthetic hinge sweep to the other display, the same sweep Device
// Hub's pose buttons drive: closed -> open moves the app to the inner display,
// open -> closed moves it back to the outer one. Progress lines go to the file
// named by BOARDSESH_DUO_HINGE_LOG.
//
// Simulator-only test plumbing. It never ships in the app and runs in no
// process but the simulator's SpringBoard.

#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <notify.h>

// Mirrors the struct SBDisplayToolServiceCoordinator's
// performDisplaySwapWithSettings:completion: takes ({qdqqBqdd}). Only the
// duration and waitForCompletion fields are set; zero everywhere else asks for
// a plain swap to the opposite display in the current orientation.
typedef struct {
  long long reserved;
  double duration;
  long long deviceOrientation;
  long long profileOverride;
  BOOL waitForCompletion;
  long long targetMode;
  double targetHingePosition;
  double reservedTail;
} BoardseshDuoSwapSettings;

static __weak id gCoordinator;
static IMP gOriginalInit;

static void BoardseshDuoLog(NSString *line) {
  const char *path = getenv("BOARDSESH_DUO_HINGE_LOG");
  if (!path) return;
  FILE *file = fopen(path, "a");
  if (!file) return;
  fprintf(file, "%s\n", line.UTF8String);
  fclose(file);
}

static id BoardseshDuoInit(id self, SEL _cmd, id contentMode, id poseProvider, id sceneManager, id yoinking) {
  id coordinator = ((id(*)(id, SEL, id, id, id, id))gOriginalInit)(self, _cmd, contentMode, poseProvider, sceneManager,
                                                                  yoinking);
  gCoordinator = coordinator;
  BoardseshDuoLog(@"coordinator ready");
  return coordinator;
}

__attribute__((constructor)) static void BoardseshDuoHingeLoad(void) {
  if (![[[NSProcessInfo processInfo] processName] isEqualToString:@"SpringBoard"]) return;
  Class coordinatorClass = objc_getClass("SBDisplayToolServiceCoordinator");
  SEL initSelector = sel_registerName(
      "initWithDisplayContentModeCoordinator:devicePoseProvider:windowSceneManager:displayYoinkingCoordinator:");
  Method initMethod = coordinatorClass ? class_getInstanceMethod(coordinatorClass, initSelector) : NULL;
  if (!initMethod) {
    BoardseshDuoLog(@"unsupported: SBDisplayToolServiceCoordinator not found");
    return;
  }
  gOriginalInit = method_setImplementation(initMethod, (IMP)BoardseshDuoInit);
  BoardseshDuoLog(@"loaded");

  int token = 0;
  notify_register_dispatch("com.boardsesh.duo-hinge.swap", &token, dispatch_get_main_queue(), ^(int unusedToken) {
    id coordinator = gCoordinator;
    if (!coordinator) {
      BoardseshDuoLog(@"swap failed: no coordinator");
      return;
    }
    BoardseshDuoSwapSettings settings = {0};
    // A non-zero duration takes the real sweep. Zero takes SpringBoard's
    // instant "yoink" path, which on the simulator never moves the content.
    settings.duration = 0.5;
    settings.waitForCompletion = YES;
    SEL swapSelector = sel_registerName("performDisplaySwapWithSettings:completion:");
    BOOL accepted = ((BOOL(*)(id, SEL, BoardseshDuoSwapSettings, id))objc_msgSend)(
        coordinator, swapSelector, settings, ^(BOOL succeeded, id unusedDetail) {
          BoardseshDuoLog([NSString stringWithFormat:@"swap done %d", succeeded]);
        });
    BoardseshDuoLog([NSString stringWithFormat:@"swap accepted %d", accepted]);
  });
}
