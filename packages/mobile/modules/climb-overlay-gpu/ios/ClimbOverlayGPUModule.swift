import ExpoModulesCore

public class ClimbOverlayGPUModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ClimbOverlayGPU")
    #if targetEnvironment(simulator)
    // The simulator SDK omits MTLDrawable.addPresentedHandler. Keep the
    // diagnostic story available, but do not promise live presentation fences.
    Constants(["apiVersion": 1, "assetApiVersion": 0, "swapCommandApi": ClimbOverlayMotion.swapCommandApi,
      "swapLookVersion": ClimbOverlaySwapLook.version])
    #else
    Constants(["apiVersion": ClimbOverlayPacketLayout.nativeApiVersion, "assetApiVersion": 0,
      "swapCommandApi": ClimbOverlayMotion.swapCommandApi, "swapLookVersion": ClimbOverlaySwapLook.version])
    #endif
    AsyncFunction("getResourceStats") { () throws -> [String: Any] in try climbOverlayPacketResourceStats() }
    AsyncFunction("compare") { (configJson: String) throws -> [String: Any] in
      try compareClimbOverlayGPU(configJson)
    }.runOnQueue(climbOverlayGPUWorkQueue)
    View(ClimbOverlayGPUView.self) {
      Events("onRenderReady", "onRenderError", "onSwapLookState")
      Prop("configJson") { (view: ClimbOverlayGPUView, config: String) in view.configJson = config }
      Prop("geometryAssetPath") { (view: ClimbOverlayGPUView, path: String?) in view.geometryAssetPath = path }
      Prop("geometryAssetSha256") { (view: ClimbOverlayGPUView, hash: String?) in view.geometryAssetSha256 = hash }
      Prop("generatedGeometryDirectory") { (view: ClimbOverlayGPUView, path: String?) in view.generatedGeometryDirectory = path }
      Prop("prefetchFrames") { (view: ClimbOverlayGPUView, frames: [String]) in view.prefetchFrames=Array(frames.prefix(2)) }
      Prop("frames") { (view: ClimbOverlayGPUView, frames: String?) in view.frames = frames }
      Prop("previousFrames") { (view: ClimbOverlayGPUView, frames: String?) in view.previousFrames = frames }
      Prop("nextFrames") { (view: ClimbOverlayGPUView, frames: String?) in view.nextFrames = frames }
      Prop("centerPage") { (view: ClimbOverlayGPUView, page: Double) in view.centerPage = page }
      Prop("pagePosition") { (view: ClimbOverlayGPUView, page: Double) in view.setPagePosition(page) }
      Prop("revealMode") { (view: ClimbOverlayGPUView, mode: String?) in view.setRevealMode(mode) }
      Prop("swapFrame") { (view: ClimbOverlayGPUView, frame: [Double]) in view.setSwapFrame(frame) }
      Prop("swapLook") { (view: ClimbOverlayGPUView, look: [Double]?) in view.setSwapLook(look) }
      Prop("swapLookStateEvents") { (view: ClimbOverlayGPUView, events: Bool?) in view.swapLookStateEvents = events ?? false }
      Prop("animateEdits") { (view: ClimbOverlayGPUView, animate: Bool) in view.animateEdits = animate }
      Prop("reduceMotion") { (view: ClimbOverlayGPUView, reduce: Bool) in view.reduceMotion = reduce }
      Prop("displayMirrored") { (view: ClimbOverlayGPUView, mirrored: Bool) in view.displayMirrored = mirrored }
      Prop("requestId") { (view: ClimbOverlayGPUView, request: String) in view.requestId = request }
      Prop("active") { (view: ClimbOverlayGPUView, active: Bool) in view.active = active }
      OnViewDidUpdateProps { view in view.applyProps() }
    }
  }
}
