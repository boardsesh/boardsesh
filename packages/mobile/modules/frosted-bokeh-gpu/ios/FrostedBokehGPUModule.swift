import ExpoModulesCore

/// The frosted bokeh behind the driving wall button, drawn by one Metal
/// fragment shader so it can move: the lights breathe while the climber drives
/// and change climbs with the board's swap (`BokehMotion`).
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
    // 1: the view takes the board's swap frames (the `swapFrame` command and
    // prop) with `swapClimbs`, `swapLook` and the release timings, and draws
    // the board's look instead of the old index glide. JS sends them only when
    // this is present (modules/frosted-bokeh-gpu/src/index.ts).
    Constants(["swapFrameApi": 1])

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
      Prop("swapClimbs") { (view: FrostedBokehGPUView, climbs: GPUSwapClimbsRecord?) in
        view.pendingSwapClimbs = climbs
      }
      Prop("swapLook") { (view: FrostedBokehGPUView, look: [Double]?) in
        view.pendingSwapLook = look
      }
      Prop("releaseMs") { (view: FrostedBokehGPUView, milliseconds: Double) in
        view.pendingReleaseMs = milliseconds
      }
      Prop("releaseOutMs") { (view: FrostedBokehGPUView, milliseconds: Double) in
        view.pendingReleaseOutMs = milliseconds
      }
      // The animated-prop copy of the `swapFrame` command, for mount; the
      // sequence drops it whenever the command already delivered the frame.
      Prop("swapFrame") { (view: FrostedBokehGPUView, frame: [Double]?) in
        if let frame { view.setSwapFrame(frame) }
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
  /// The physical hold's id, or -1: names the light across climbs.
  @Field var id: Double = -1
  /// The breathing phase, 0..<2π, or -1 for a hash of the position.
  @Field var seed: Double = -1
}

/// One neighbour climb the board can swap to: its layer key and blobs.
struct GPUSwapClimbRecord: Record {
  @Field var key: String = ""
  @Field var blobs: [GPUBlobRecord] = []
}

/// The board's pages around the climb on show (`blobs` / `layerKey`), which
/// sits on `centerPage`.
struct GPUSwapClimbsRecord: Record {
  @Field var centerPage: Double = 0
  @Field var previous: GPUSwapClimbRecord? = nil
  @Field var next: GPUSwapClimbRecord? = nil
}
