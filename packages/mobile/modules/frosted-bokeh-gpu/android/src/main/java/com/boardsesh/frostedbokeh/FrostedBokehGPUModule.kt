package com.boardsesh.frostedbokeh

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class FrostedBokehGPUModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("FrostedBokehGPU")
        View(FrostedBokehGPUView::class) {
            Events("onRenderError")
            Prop("blobs") { view: FrostedBokehGPUView, blobs: List<GPUBlobRecord> -> view.pendingBlobs = blobs }
            Prop("base") { view: FrostedBokehGPUView, base: String -> view.pendingBase = base }
            Prop("blend") { view: FrostedBokehGPUView, blend: String -> view.pendingBlend = blend }
            Prop("layerKey") { view: FrostedBokehGPUView, key: String -> view.pendingKey = key }
            Prop("reduceMotion") { view: FrostedBokehGPUView, reduce: Boolean -> view.pendingReduceMotion = reduce }
            Prop("drift") { view: FrostedBokehGPUView, drift: Double -> view.pendingDrift = drift }
            Prop("swell") { view: FrostedBokehGPUView, swell: Double -> view.pendingSwell = swell }
            Prop("glideMs") { view: FrostedBokehGPUView, milliseconds: Double -> view.pendingGlideMs = milliseconds }
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
}
