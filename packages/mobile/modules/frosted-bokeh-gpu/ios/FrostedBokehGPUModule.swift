import ExpoModulesCore

/// The frosted bokeh behind the driving wall button, drawn by one Metal
/// fragment shader so it can move: the lights breathe while the climber drives
/// and slide to the next climb's holds on Next.
///
/// JS still owns everything about the look: the blob geometry and colours
/// (`@boardsesh/frosted-bokeh`), the motion constants, the label fade, frost
/// and grain. This view only draws the blobs over the base colour.
public class FrostedBokehGPUModule: Module {
  public func definition() -> ModuleDefinition {
    // The contract with JS: modules/frosted-bokeh-gpu/src/index.ts resolves
    // this name with requireOptionalNativeModule, so a binary without it (every
    // store build before it shipped, Android, the web) keeps the React Native
    // blobs instead of crashing.
    Name("FrostedBokehGPU")

    View(FrostedBokehGPUView.self) {
      Events("onRenderError")

      Prop("blobs") { (view: FrostedBokehGPUView, blobs: [GPUBlobRecord]) in
        view.pendingBlobs = blobs
      }
      Prop("base") { (view: FrostedBokehGPUView, base: String) in
        view.pendingBase = base
      }
      Prop("blend") { (view: FrostedBokehGPUView, blend: String) in
        view.pendingBlend = blend
      }
      Prop("layerKey") { (view: FrostedBokehGPUView, key: String) in
        view.pendingKey = key
      }
      Prop("reduceMotion") { (view: FrostedBokehGPUView, reduceMotion: Bool) in
        view.pendingReduceMotion = reduceMotion
      }
      Prop("drift") { (view: FrostedBokehGPUView, drift: Double) in
        view.pendingDrift = drift
      }
      Prop("swell") { (view: FrostedBokehGPUView, swell: Double) in
        view.pendingSwell = swell
      }
      Prop("glideMs") { (view: FrostedBokehGPUView, glideMs: Double) in
        view.pendingGlideMs = glideMs
      }
      OnViewDidUpdateProps { view in
        view.applyProps()
      }
    }
  }
}

struct GPUBlobRecord: Record {
  @Field var x: Double = 0
  @Field var y: Double = 0
  @Field var r: Double = 0
  /// Peak alpha with the platform's opacity scale already applied.
  @Field var peak: Double = 0
  @Field var color: String = "#000000"
}
