package com.boardsesh.frostedbokeh

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RuntimeShader
import androidx.annotation.RequiresApi

internal interface BokehPainter {
    fun draw(canvas: Canvas, width: Int, height: Int, blobs: List<BokehBlob>, base: FloatArray,
             blend: Float, density: Float, time: Float, drift: Float, swell: Float, breathing: Boolean)
}

/** Kept in a separate class so pre-33 devices never load RuntimeShader. */
@RequiresApi(33)
internal class AgslBokehPainter : BokehPainter {
    private val shader = RuntimeShader(SOURCE)
    private val paint = Paint().apply { shader = this@AgslBokehPainter.shader }
    private val geometry = FloatArray(MAX_BLOBS * 4)
    private val colors = FloatArray(MAX_BLOBS * 4)

    override fun draw(canvas: Canvas, width: Int, height: Int, blobs: List<BokehBlob>, base: FloatArray,
                      blend: Float, density: Float, time: Float, drift: Float, swell: Float, breathing: Boolean) {
        blobs.forEachIndexed { index, blob ->
            val offset = index * 4
            geometry[offset] = blob.x
            geometry[offset + 1] = blob.y
            geometry[offset + 2] = blob.radius
            geometry[offset + 3] = blob.peak
            colors[offset] = blob.red
            colors[offset + 1] = blob.green
            colors[offset + 2] = blob.blue
            colors[offset + 3] = 1f
        }
        shader.setFloatUniform("geometry", geometry)
        shader.setFloatUniform("colors", colors)
        shader.setFloatUniform("base", base)
        shader.setIntUniform("count", blobs.size)
        shader.setFloatUniform("blend", blend)
        shader.setFloatUniform("density", density)
        shader.setFloatUniform("time", time)
        shader.setFloatUniform("drift", drift)
        shader.setFloatUniform("swell", swell)
        shader.setFloatUniform("motion", if (breathing) 1f else 0f)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    }

    companion object {
        // Metal's BOKEH_FALLOFF and orbit, with a constant loop bound for AGSL.
        // Inputs and blending stay in sRGB. Convert only the finished pixel to
        // Canvas's working color space (also correct on wide-gamut windows).
        internal const val SOURCE = """
            uniform float4 geometry[30];
            uniform float4 colors[30];
            uniform float4 base;
            uniform int count;
            uniform float blend;
            uniform float density;
            uniform float time;
            uniform float drift;
            uniform float swell;
            uniform float motion;

            float falloff(float t) {
                if (t >= 1.0) return 0.0;
                if (t <= 0.3) return mix(1.0, 0.8, t / 0.3);
                if (t <= 0.55) return mix(0.8, 0.4, (t - 0.3) / 0.25);
                if (t <= 0.8) return mix(0.4, 0.12, (t - 0.55) / 0.25);
                return mix(0.12, 0.0, (t - 0.8) / 0.2);
            }
            float3 blendOver(float3 dst, float3 src, float alpha) {
                float3 blended = blend < 0.5 ? 1.0 - (1.0 - dst) * (1.0 - src) :
                    (blend < 1.5 ? dst * src : src);
                return dst * (1.0 - alpha) + blended * alpha;
            }
            float linearChannel(float channel) {
                return channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4);
            }
            half4 main(float2 coordinates) {
                float2 point = coordinates / density;
                float3 pixel = base.rgb;
                for (int index = 0; index < 30; index++) {
                    if (index < count) {
                        float4 blob = geometry[index];
                        float2 centre = blob.xy;
                        float peak = blob.w;
                        float ordinal = float(index);
                        if (motion > 0.5) {
                            float2 orbit = float2(sin(time * 0.55 + ordinal * 1.7), cos(time * 0.42 + ordinal * 2.3));
                            centre += orbit * (drift * inversesqrt(max(dot(orbit, orbit), 1.0)));
                            peak *= 1.0 + swell * (0.5 + 0.5 * sin(time * 0.9 + ordinal * 2.1));
                        }
                        float distanceToCentre = distance(point, centre);
                        if (blob.z > 0.0 && distanceToCentre < blob.z) {
                            float alpha = clamp(falloff(distanceToCentre / blob.z) * peak, 0.0, 1.0);
                            pixel = blendOver(pixel, colors[index].rgb, alpha);
                        }
                    }
                }
                float3 linear = float3(linearChannel(pixel.r), linearChannel(pixel.g), linearChannel(pixel.b));
                return half4(fromLinearSrgb(linear), 1.0);
            }
        """
    }
}
