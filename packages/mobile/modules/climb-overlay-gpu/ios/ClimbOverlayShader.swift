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
    uint4 identity;
  };
  struct Uniforms {
    float4 size; // output width, height, active count, draw glow
    float4 veil;
    float4 tuning; // merge, seam, max mix, sharpness
    float4 tuning2; // fringe, core share, active max reach
    uint4 offsets; // LED covers
    float4 viewport;
    float4 motion; // progress, reveal band width, reserved, editor illumination
    float4 other; // second count, second max reach, empty production source, display mirror
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
  Hold source_hold(uint index, uint lowerCount, device const Hold* lower, device const Hold* upper) {
    return index<lowerCount ? lower[index] : upper[index-lowerCount];
  }
  float reveal_weight(Hold hold, bool upper, constant Uniforms& uniforms) {
    float membership=upper ? hold.numbers.z : hold.numbers.w;
    // A shared same-role hold stays fully lit, and appears only once.
    if(membership==1) return upper ? 0 : 1;
    float center=clamp((hold.bounds.x+hold.bounds.z)*0.5/uniforms.size.x,0.0,1.0);
    if(uniforms.other.w>0) center=1-center;
    float halfBand=uniforms.motion.y*0.5;
    float boundary=1+halfBand-uniforms.motion.x*(1+2*halfBand);
    float reveal=smoothstep(boundary-halfBand,boundary+halfBand,center);
    // One weight for the entire hold, not for each pixel. A changed role
    // goes fully dark before the other role appears: no half-start/half-finish.
    if(membership==2) return upper ? max(2*reveal-1,0.0) : max(1-2*reveal,0.0);
    return upper ? reveal : 1-reveal;
  }
  float4 scene_pixel(uint2 point, device const uchar* atlas, device const Hold* lower,
      device const Hold* upper, constant Uniforms& uniforms, device const float* lut,
      uint lowerCount, uint upperCount, float maxReach, bool transitioning, float illumination) {
    uint count=lowerCount+upperCount;
    // Production empty frames show the bare board, matching the CPU host.
    // Legacy parity diagnostics retain their explicit veil-only empty image.
    if(count==0 && uniforms.other.z>0) return float4(0);
    float ambient=transitioning && uniforms.other.z>0
      ? mix(lowerCount>0 ? 1.0 : 0.0,upperCount>0 ? 1.0 : 0.0,uniforms.motion.x) : 1;
    float4 pixel = quantize(uniforms.veil*ambient);
    float coverage = 0;
    float best = 1e20, second = 1e20;
    float bestScore=1e20, secondScore=1e20;
    int nearest = -1, runner = -1;
    float dilation = ceil(maxReach)+2;
    for (uint index=0;index<count;index++) {
      Hold hold = source_hold(index,lowerCount,lower,upper);
      int local = index_at(point,hold);
      if(local < 0) continue;
      float weight=transitioning ? reveal_weight(hold,index>=lowerCount,uniforms) : 1;
      if(weight<=0) continue;
      device const float* fields = reinterpret_cast<device const float*>(atlas+hold.offsets.x);
      float dist2 = fields[local*2];
      float alpha = fields[local*2+1]*weight;
      coverage = max(coverage,alpha);
      pixel = quantize(pixel*(1.0-alpha));
      // Match the CPU crop for THIS climb, even though the immutable atlas
      // carries enough padding for the widest hold in the layout.
      if(dist2>=1e20 || hold.numbers.x <= 0 || float(point.x)<floor(hold.bounds.x-dilation) ||
         float(point.y)<floor(hold.bounds.y-dilation) || float(point.x)>=ceil(hold.bounds.z+dilation) ||
         float(point.y)>=ceil(hold.bounds.w+dilation)) continue;
      // Faint incoming fields must not steal an existing glow, even at d=0.
      // Keep real distance for falloff, and use a continuous positive fade
      // bias for ownership and seam interpolation during the reveal only.
      float score=transitioning ? max(sqrt(dist2)-0.5,0.0)+hold.numbers.x*(1-weight)/max(weight,0.0001) : dist2;
      if(transitioning && nearest>=0 && hold.identity.x==source_hold(uint(nearest),lowerCount,lower,upper).identity.x) continue;
      if(score<bestScore) {
        second=best;secondScore=bestScore;runner=nearest;
        best=dist2;bestScore=score;nearest=int(index);
      } else if(score<secondScore && (!transitioning || runner<0 ||
          hold.identity.x!=source_hold(uint(runner),lowerCount,lower,upper).identity.x)) {
        second=dist2;secondScore=score;runner=int(index);
      }
    }
    pixel=over(pixel,read_rgba(atlas,uniforms.offsets.x+(point.y*uint(uniforms.size.x)+point.x)*4)*ambient);
    if(uniforms.size.w > 0 && nearest>=0) {
      Hold hold=source_hold(uint(nearest),lowerCount,lower,upper);
      float weight=transitioning ? reveal_weight(hold,uint(nearest)>=lowerCount,uniforms) : 1;
      float reach=hold.numbers.x;
      float distance=max(sqrt(best)-0.5,0.0);
      float fraction=distance/reach;
      float3 color=hold.color.rgb;
      if(runner>=0) {
        Hold other=source_hold(uint(runner),lowerCount,lower,upper);
        float otherDistance=transitioning ? distance+max(secondScore-bestScore,0.0) : max(sqrt(second)-0.5,0.0);
        if(all(other.color.rgb==color)) {
          float softness=uniforms.tuning.x*reach;
          if(softness>0) {
            float h=clamp(0.5+0.5*(otherDistance-distance)/softness,0.0,1.0);
            fraction=min(max(otherDistance*(1-h)+distance*h-softness*h*(1-h),0.0)/reach,1.0);
          }
        } else {
          float band=uniforms.tuning.y*reach;
          float gap=transitioning ? secondScore-bestScore : otherDistance-distance;
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
        alpha*=weight;
        alpha=min(1.0,alpha*(hold.numbers.y>0 ? illumination : 1));
        if(alpha>0.002) pixel=over(pixel,float4(color*alpha,alpha));
      }
    }
    // Preserve CPU layer order across holds: all fills, then all plates,
    // then all glyphs. Combining each hold's layers would change overlaps.
    for(uint layer=1;layer<4;layer++) {
      for(uint index=0;index<count;index++) {
        Hold hold=source_hold(index,lowerCount,lower,upper);
        if(hold.offsets[layer]==0xffffffffu) continue;
        int local=index_at(point,hold);
        if(local<0) continue;
        float weight=transitioning ? reveal_weight(hold,index>=lowerCount,uniforms) : 1;
        if(weight>0)
          pixel=over(pixel,read_rgba(atlas,hold.offsets[layer]+uint(local)*4)*weight);
      }
    }
    return pixel;
  }
  fragment float4 overlay_fragment(float4 position [[position]],
      device const uchar* atlas [[buffer(0)]], device const Hold* lower [[buffer(1)]],
      constant Uniforms& uniforms [[buffer(2)]], device const float* lut [[buffer(3)]],
      device const Hold* upper [[buffer(4)]]) {
    uint2 point = min(uint2(position.xy / uniforms.viewport.xy * uniforms.size.xy),uint2(uniforms.size.xy)-1);
    float progress=uniforms.motion.x;
    // Exact endpoints use the original still compositor, without weighting.
    if(progress<=0) return scene_pixel(point,atlas,lower,lower,uniforms,lut,uint(uniforms.size.z),0,
      uniforms.tuning2.z,false,uniforms.motion.w);
    if(progress>=1) return scene_pixel(point,atlas,upper,upper,uniforms,lut,uint(uniforms.other.x),0,
      uniforms.other.y,false,1);
    // One union field, one veil/LED cover pass, one set of mark layers.
    // No geometry or buffers change while the UI-thread progress moves.
    return scene_pixel(point,atlas,lower,upper,uniforms,lut,uint(uniforms.size.z),uint(uniforms.other.x),
      max(uniforms.tuning2.z,uniforms.other.y),true,1);
  }
  """
}
