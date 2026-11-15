import Foundation

enum ClimbOverlayShader {
  static let source = """
  #include <metal_stdlib>
  using namespace metal;
  struct Hold {
    float4 color;
    float4 bounds;
    uint4 crop;
    uint4 offsets;
    float4 numbers;
  };
  struct Uniforms {
    float4 size; // output width, height, active count, draw glow
    float4 veil;
    float4 tuning; // merge, seam, max mix, sharpness
    float4 tuning2; // fringe, core share, active max reach
    uint4 offsets; // LED covers
    float4 viewport;
  };
  vertex float4 overlay_vertex(uint index [[vertex_id]]) {
    const float2 points[] = {float2(-1,-1),float2(3,-1),float2(-1,3)};
    return float4(points[index],0,1);
  }
  float4 quantize(float4 pixel) { return round(clamp(pixel,0.0,1.0)*255.0)/255.0; }
  float4 over(float4 under, float4 above) {
    return quantize(above + under * (1.0-above.a));
  }
  float4 read_rgba(device const uchar* atlas, uint offset) {
    return float4(atlas[offset],atlas[offset+1],atlas[offset+2],atlas[offset+3])/255.0;
  }
  int index_at(uint2 point, Hold hold) {
    if (point.x < hold.crop.x || point.y < hold.crop.y ||
        point.x >= hold.crop.x+hold.crop.z || point.y >= hold.crop.y+hold.crop.w) return -1;
    return int((point.y-hold.crop.y)*hold.crop.z+point.x-hold.crop.x);
  }
  fragment float4 overlay_fragment(float4 position [[position]],
      device const uchar* atlas [[buffer(0)]], device const Hold* holds [[buffer(1)]],
      constant Uniforms& uniforms [[buffer(2)]], device const float* lut [[buffer(3)]]) {
    uint2 point = min(uint2(position.xy / uniforms.viewport.xy * uniforms.size.xy), uint2(uniforms.size.xy)-1);
    uint count = uint(uniforms.size.z);
    float4 pixel = uniforms.veil;
    float coverage = 0;
    float best = 1e20, second = 1e20;
    int nearest = -1, runner = -1;
    float dilation = ceil(uniforms.tuning2.z)+2;
    for (uint index=0;index<count;index++) {
      Hold hold = holds[index];
      int local = index_at(point,hold);
      if(local < 0) continue;
      device const float* fields = reinterpret_cast<device const float*>(atlas+hold.offsets.x);
      float dist2 = fields[local*2];
      float alpha = fields[local*2+1];
      coverage = max(coverage,alpha);
      pixel = quantize(pixel*(1.0-alpha));
      // Match the CPU crop for THIS climb, even though the immutable atlas
      // carries enough padding for the widest hold in the layout.
      if(hold.numbers.x <= 0 || float(point.x)<floor(hold.bounds.x-dilation) ||
         float(point.y)<floor(hold.bounds.y-dilation) || float(point.x)>=ceil(hold.bounds.z+dilation) ||
         float(point.y)>=ceil(hold.bounds.w+dilation)) continue;
      if(dist2 < best) { second=best;runner=nearest;best=dist2;nearest=int(index); }
      else if(dist2 < second) { second=dist2;runner=int(index); }
    }
    pixel=over(pixel,read_rgba(atlas,uniforms.offsets.x+(point.y*uint(uniforms.size.x)+point.x)*4));
    if(uniforms.size.w > 0 && nearest>=0) {
      Hold hold=holds[nearest];
      float reach=hold.numbers.x;
      float distance=max(sqrt(best)-0.5,0.0);
      float fraction=distance/reach;
      float3 color=hold.color.rgb;
      if(runner>=0) {
        Hold other=holds[runner];
        float otherDistance=max(sqrt(second)-0.5,0.0);
        if(all(other.color.rgb==color)) {
          float softness=uniforms.tuning.x*reach;
          if(softness>0) {
            float h=clamp(0.5+0.5*(otherDistance-distance)/softness,0.0,1.0);
            fraction=min(max(otherDistance*(1-h)+distance*h-softness*h*(1-h),0.0)/reach,1.0);
          }
        } else {
          float band=uniforms.tuning.y*reach;
          float gap=otherDistance-distance;
          if(band>0 && gap<band) {
            float closeness=clamp(1-gap/band,0.0,1.0);
            float amount=uniforms.tuning.z*pow(closeness,uniforms.tuning.w);
            color=round(mix(color,other.color.rgb,amount)*255.0)/255.0;
          }
        }
      }
      if(fraction<1) {
        float at=clamp(fraction,0.0,1.0)*256;
        uint index=min(uint(at),255u);
        float alpha=mix(lut[index],lut[index+1],at-float(index));
        float deepen=uniforms.tuning2.x*smoothstep(uniforms.tuning2.y,1.0,fraction);
        float3 deep=round(hold.color.rgb*255.0*0.35)/255.0;
        color=round(mix(color,deep,deepen)*255.0)/255.0;
        alpha*=1-coverage;
        if(alpha>0.002) pixel=over(pixel,float4(color*alpha,alpha));
      }
    }
    // Preserve CPU layer order across holds: all fills, then all plates,
    // then all glyphs. Combining each hold's layers would change overlaps.
    for(uint layer=1;layer<4;layer++) {
      for(uint index=0;index<count;index++) {
        Hold hold=holds[index];
        int local=index_at(point,hold);
        if(local>=0 && hold.offsets[layer]!=0xffffffffu) pixel=over(pixel,read_rgba(atlas,hold.offsets[layer]+uint(local)*4));
      }
    }
    return pixel;
  }
  """
}
