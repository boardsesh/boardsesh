package com.boardsesh.frostedbokeh

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class FrostedBokehGPUModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("FrostedBokehGPU")
        // 1: the view takes the board's swap frames (the `swapFrame` command and prop) with
        // `swapClimbs`, `swapLook` and the release timings, and draws the board's look instead
        // of the old index glide. JS sends them only when this is present.
        Constants("swapFrameApi" to 1)
        View(FrostedBokehGPUView::class) {
            Events("onRenderError")
            Prop("blobs") { view: FrostedBokehGPUView, blobs: List<GPUBlobRecord> -> view.pendingBlobs = blobs }
            Prop("base") { view: FrostedBokehGPUView, base: String -> view.pendingBase = base }
            Prop("blend") { view: FrostedBokehGPUView, blend: String -> view.pendingBlend = blend }
            Prop("layerKey") { view: FrostedBokehGPUView, key: String -> view.pendingKey = key }
            Prop("reduceMotion") { view: FrostedBokehGPUView, reduce: Boolean -> view.pendingReduceMotion = reduce }
            Prop("drift") { view: FrostedBokehGPUView, drift: Double -> view.pendingDrift = drift }
            Prop("swell") { view: FrostedBokehGPUView, swell: Double -> view.pendingSwell = swell }
            Prop("swapClimbs") { view: FrostedBokehGPUView, climbs: GPUSwapClimbsRecord? -> view.pendingSwapClimbs = climbs }
            Prop("swapLook") { view: FrostedBokehGPUView, look: List<Double>? -> view.pendingSwapLook = look }
            Prop("releaseMs") { view: FrostedBokehGPUView, milliseconds: Double -> view.pendingReleaseMs = milliseconds }
            Prop("releaseOutMs") { view: FrostedBokehGPUView, milliseconds: Double -> view.pendingReleaseOutMs = milliseconds }
            // The animated-prop copy of the `swapFrame` command, for mount; the sequence drops it
            // whenever the command already delivered the frame.
            Prop("swapFrame") { view: FrostedBokehGPUView, frame: List<Double>? -> if (frame != null) view.setSwapFrame(frame) }
            OnViewDidUpdateProps { view: FrostedBokehGPUView -> view.applyProps() }
            OnViewDestroys { view: FrostedBokehGPUView -> view.dispose() }
        }
    }
}

class GPUBlobRecord : Record {
    @Field val x: Double = 0.0
    @Field val y: Double = 0.0
    @Field val r: Double = 0.0
    @Field val peak: Double = 0.0
    @Field val color: String = "#000000"
    /** The physical hold's id, or -1: names the light across climbs. */
    @Field val id: Double = -1.0
    /** The breathing phase, 0..<2π, or -1 for a hash of the position. */
    @Field val seed: Double = -1.0
}

/** One neighbour climb the board can swap to: its layer key and blobs. */
class GPUSwapClimbRecord : Record {
    @Field val key: String = ""
    @Field val blobs: List<GPUBlobRecord> = emptyList()
}

/** The board's pages around the climb on show (`blobs` / `layerKey`), which sits on `centerPage`. */
class GPUSwapClimbsRecord : Record {
    @Field val centerPage: Double = 0.0
    @Field val previous: GPUSwapClimbRecord? = null
    @Field val next: GPUSwapClimbRecord? = null
}
