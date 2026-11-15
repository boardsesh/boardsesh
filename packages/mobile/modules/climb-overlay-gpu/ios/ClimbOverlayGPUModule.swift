import ExpoModulesCore

public class ClimbOverlayGPUModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ClimbOverlayGPU")
    AsyncFunction("compare") { (configJson: String) throws -> [String: Any] in
      try compareClimbOverlayGPU(configJson)
    }.runOnQueue(climbOverlayGPUWorkQueue)
    View(ClimbOverlayGPUView.self) {
      Events("onRenderReady", "onRenderError")
      Prop("configJson") { (view: ClimbOverlayGPUView, config: String) in view.configJson = config }
      Prop("requestId") { (view: ClimbOverlayGPUView, request: String) in view.requestId = request }
      Prop("active") { (view: ClimbOverlayGPUView, active: Bool) in view.active = active }
      OnViewDidUpdateProps { view in view.applyProps() }
    }
  }
}
