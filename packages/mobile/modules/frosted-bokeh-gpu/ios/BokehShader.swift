/// The frosted bokeh blobs in one fragment pass, the same sum `bokehPixel` in
/// `@boardsesh/frosted-bokeh` computes: the piecewise-linear `BOKEH_FALLOFF`
/// per blob, composited over the base in sRGB space with the CSS blend the
/// React Native views use. `motion` adds the breathing: each light drifts on
/// its own slow orbit (radius `drift` points) and swells by up to `swell` of
/// its peak. Gliding between climbs happens on the CPU, which hands this pass
/// the in-between blobs.
///
/// Compiled from source at runtime (`BokehRenderer`), so no metallib has to
/// survive CocoaPods packaging. Layouts must match `GPUBlob` / `GPUUniforms`.
let bokehShaderSource = """
#include <metal_stdlib>
using namespace metal;

struct Blob { float2 pos; float r; float peak; float4 color; };
struct Uniforms {
  float2 size; float time; float blend;
  float4 base;
  int count; float drift; float scale; float motion;
  float swell; float pad0; float pad1; float pad2;
};
struct VOut { float4 position [[position]]; };

vertex VOut bokehVertex(uint vid [[vertex_id]]) {
  float2 corner = float2((vid << 1) & 2, vid & 2);
  VOut out;
  out.position = float4(corner * 2.0 - 1.0, 0.0, 1.0);
  return out;
}

// BOKEH_FALLOFF: [0,1] [0.3,0.8] [0.55,0.4] [0.8,0.12] [1,0]
static float falloff(float t) {
  if (t >= 1.0) return 0.0;
  if (t <= 0.3) return mix(1.0, 0.8, t / 0.3);
  if (t <= 0.55) return mix(0.8, 0.4, (t - 0.3) / 0.25);
  if (t <= 0.8) return mix(0.4, 0.12, (t - 0.55) / 0.25);
  return mix(0.12, 0.0, (t - 0.8) / 0.2);
}

// 0 screen, 1 multiply, 2 normal: the blend `bokehPixel` names.
static float3 blendOver(float3 dst, float3 src, float alpha, float mode) {
  float3 blended = mode < 0.5 ? 1.0 - (1.0 - dst) * (1.0 - src) : (mode < 1.5 ? dst * src : src);
  return dst * (1.0 - alpha) + blended * alpha;
}

fragment float4 bokehFragment(VOut in [[stage_in]],
                              constant Uniforms &u [[buffer(0)]],
                              constant Blob *blobs [[buffer(1)]]) {
  float2 p = in.position.xy / u.scale;
  float3 value = u.base.rgb;
  for (int i = 0; i < u.count; i++) {
    Blob b = blobs[i];
    float fi = float(i);
    float2 centre = b.pos;
    float peak = b.peak;
    if (u.motion > 0.5) {
      // A unit-circle orbit at most, so a light never strays past `drift`.
      float2 orbit = float2(sin(u.time * 0.55 + fi * 1.7), cos(u.time * 0.42 + fi * 2.3));
      centre += orbit * (u.drift * rsqrt(max(dot(orbit, orbit), 1.0)));
      peak *= 1.0 + u.swell * (0.5 + 0.5 * sin(u.time * 0.9 + fi * 2.1));
    }
    float d = distance(p, centre);
    if (d >= b.r) continue;
    float alpha = clamp(falloff(d / b.r) * peak, 0.0, 1.0);
    value = blendOver(value, b.color.rgb, alpha, u.blend);
  }
  return float4(value, 1.0);
}
"""
