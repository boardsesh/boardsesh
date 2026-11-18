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
    uint4 fillCrop;
    uint4 plateCrop;
    uint4 glyphCrop;
    uint4 extraOffsets;
    uint4 fillCrop1;
    uint4 fillCrop2;
    uint4 fillCrop3;
    uint4 glyphCrop1;
  };
  struct Uniforms {
    float4 size; // output width, height, active count, draw glow
    float4 veil;
    float4 tuning; // merge, seam, max mix, sharpness
    float4 tuning2; // fringe, core share, active max reach, wall-swap shared-hold weight
    uint4 offsets; // LED covers, active stamp-layer mask
    float2 viewport;
    float2 swapWeights; // wall swap: lower-only and upper-only hold weights
    float4 motion; // progress, reveal band width, reveal mode (0 wipe, 1 swap), editor reach scale
    float4 other; // second count, second max reach, empty production source, display mirror
    uint4 coverCrop;
  };
  vertex float4 overlay_vertex(uint index [[vertex_id]]) {
    const float2 points[] = {float2(-1,-1),float2(3,-1),float2(-1,3)};
    return float4(points[index],0,1);
  }
  float4 quantize(float4 pixel) { return round(clamp(pixel,0.0,1.0)*255.0)/255.0; }
  float4 over(float4 under, float4 above) {
    return quantize(above + under * (1.0-above.a));
  }
  // Match tiny-skia's lowp source-over for rasterized byte stamps. Glow uses
  // the float compositor above; flattening or re-rounding stamp subpasses
  // changes overlapping antialias coverage by several channel bytes.
  float4 stamp_over(float4 under, float4 above) {
    uint4 source=uint4(round(clamp(above,0.0,1.0)*255.0));
    uint4 destination=uint4(round(clamp(under,0.0,1.0)*255.0));
    return float4(min(source+((destination*(255u-source.a)+255u)>>8u),uint4(255u)))/255.0;
  }
  float4 read_rgba(device const uchar* atlas, uint offset) {
    return float4(atlas[offset],atlas[offset+1],atlas[offset+2],atlas[offset+3])/255.0;
  }
  int crop_index(uint2 point, uint4 crop) {
    if (point.x < crop.x || point.y < crop.y ||
        point.x >= crop.x+crop.z || point.y >= crop.y+crop.w) return -1;
    return int((point.y-crop.y)*crop.z+point.x-crop.x);
  }
  int index_at(uint2 point, Hold hold) { return crop_index(point,hold.crop); }
  Hold source_hold(uint index, uint lowerCount, device const Hold* lower, device const Hold* upper) {
    return index<lowerCount ? lower[index] : upper[index-lowerCount];
  }
  // Directory entries and ordinals are encoded by Rust in original draw order.
  // Reserved-zero directories retain the legacy full-scan compatibility path.
  uint2 tile_range(uint2 point, uint directory, uint count, constant Uniforms& uniforms,
      device const float* lut) {
    if(count==0 || directory==0xffffffffu) return uint2(0,0);
    if(directory<\(ClimbOverlayPacketLayout.lutWords)u) return uint2(0xffffffffu,count);
    uint columns=(uint(uniforms.size.x)+\(ClimbOverlayPacketLayout.tileEdge)-1u)/\(ClimbOverlayPacketLayout.tileEdge)u;
    uint tile=(point.y/\(ClimbOverlayPacketLayout.tileEdge)u)*columns+point.x/\(ClimbOverlayPacketLayout.tileEdge)u;
    device const uint* resources=reinterpret_cast<device const uint*>(lut);
    return uint2(resources[directory+tile*2u],resources[directory+tile*2u+1u]);
  }
  uint tile_index(uint ordinal, uint2 lowerRange, uint2 upperRange, uint lowerCount,
      device const float* lut) {
    bool upper=ordinal>=lowerRange.y;
    uint2 range=upper ? upperRange : lowerRange;
    uint local=upper ? ordinal-lowerRange.y : ordinal;
    device const uint* resources=reinterpret_cast<device const uint*>(lut);
    return (upper ? lowerCount : 0u)+(range.x==0xffffffffu ? local : resources[range.x+local]);
  }
  float reveal_weight(Hold hold, bool upper, constant Uniforms& uniforms) {
    float membership=upper ? hold.numbers.z : hold.numbers.w;
    // A shared same-role hold appears only once, on the lower side. The wipe
    // keeps it fully lit; the wall swap gives it the app's shared weight.
    if(membership==1) return upper ? 0 : (uniforms.motion.z>0.5 ? uniforms.tuning2.w : 1);
    // Wall swap: one weight per side, wherever the hold is. A changed hold
    // shows only its stronger role (the lower one on a tie), never two marks.
    if(uniforms.motion.z>0.5) {
      float own=upper ? uniforms.swapWeights.y : uniforms.swapWeights.x;
      float other=upper ? uniforms.swapWeights.x : uniforms.swapWeights.y;
      if(membership==2 && (upper ? own<=other : own<other)) return 0;
      return own;
    }
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
  // Swap look (ClimbOverlaySwapLook): Swift writes one ushort4 per union hold
  // after a header: mark and glow weights in 1/65535 steps, glow reach in
  // 1/32768 (reach 1 decodes exactly).
  float4 look_hold(constant ushort4* look, uint index) {
    return float4(look[1u+index])*float4(1.0/65535.0,1.0/65535.0,1.0/32768.0,0.0);
  }
  float4 scene_pixel(uint2 point, device const uchar* atlas, device const Hold* lower,
      device const Hold* upper, constant Uniforms& uniforms, device const float* lut,
      uint lowerCount, uint upperCount, float maxReach, bool transitioning, float reachScale,
      uint lowerDirectory, uint upperDirectory, constant ushort4* look, bool shaped) {
    uint count=lowerCount+upperCount;
    uint2 lowerRange=tile_range(point,lowerDirectory,lowerCount,uniforms,lut);
    uint2 upperRange=tile_range(point,upperDirectory,upperCount,uniforms,lut);
    uint candidates=lowerRange.y+upperRange.y;
    // Production empty frames show the bare board, matching the CPU host.
    // Legacy parity diagnostics retain their explicit veil-only empty image.
    if(count==0 && uniforms.other.z>0) return float4(0);
    float ambient=transitioning && uniforms.other.z>0
      ? mix(lowerCount>0 ? 1.0 : 0.0,upperCount>0 ? 1.0 : 0.0,uniforms.motion.x) : 1;
    float4 pixel = quantize(uniforms.veil*ambient);
    float coverage = 0;
    // Shaped only: every visible hold's silhouette, so a halo never paints inside
    // a hold whose mark is fainter than its glow (a ghost). It comes in over a
    // hold's first 0.1 of glow, so a neighbour's halo never vanishes from inside
    // a ghost in one frame. Equal to coverage whenever every mark is whole.
    float mask = 0;
    float best = 1e20, second = 1e20;
    float bestScore=1e20, secondScore=1e20;
    int nearest = -1, runner = -1;
    // Shaped only: the two nearest visible holds past their own reach, by plain
    // distance, and the nearest one's faint-field bias.
    float outside=1e20, outsideNext=1e20, outsideBias=0;
    int outsider=-1, outsiderNext=-1;
    for (uint ordinal=0;ordinal<candidates;ordinal++) {
      uint index=tile_index(ordinal,lowerRange,upperRange,lowerCount,lut);
      Hold hold = source_hold(index,lowerCount,lower,upper);
      if(hold.identity.z>0) continue; // Annotation: no silhouette coverage or glow.
      int local = index_at(point,hold);
      if(local < 0) continue;
      float4 shape=shaped ? look_hold(look,index) : float4(0);
      float weight=shaped ? shape.x : (transitioning ? reveal_weight(hold,index>=lowerCount,uniforms) : 1);
      float glowWeight=shaped ? shape.y : weight;
      if(glowWeight<=0) continue;
      device const uint* fields = reinterpret_cast<device const uint*>(atlas+hold.offsets.x);
      uint field = fields[local];
      uint squared = field & 0x00ffffffu;
      float dist2 = squared==0x00ffffffu ? 1e20 : float(squared);
      float alpha = float(field >> 24)/255.0*weight;
      coverage = max(coverage,alpha);
      if(shaped) mask=max(mask,float(field >> 24)/255.0*saturate(glowWeight*10.0));
      pixel = quantize(pixel*(1.0-alpha));
      // Shaped: never smaller than the still crop, so a hold whose halo pulls in
      // keeps the pixels it could still own at rest.
      float dilation = ceil(maxReach*(shaped ? max(shape.z,1.0) : (hold.numbers.y>0 ? reachScale : 1)))+2;
      // Match the CPU crop for THIS climb, even though the immutable atlas
      // carries enough padding for the widest hold in the layout.
      if(dist2>=1e20 || hold.numbers.x <= 0 || float(point.x)<floor(hold.bounds.x-dilation) ||
         float(point.y)<floor(hold.bounds.y-dilation) || float(point.x)>=ceil(hold.bounds.z+dilation) ||
         float(point.y)>=ceil(hold.bounds.w+dilation)) continue;
      // Faint incoming fields must not steal an existing glow, even at d=0.
      // Keep real distance for falloff, and use a continuous positive fade
      // bias for ownership and seam interpolation during the reveal only.
      float bias=hold.numbers.x*(1-glowWeight)/max(glowWeight,0.0001);
      float score=transitioning ? max(sqrt(dist2)-0.5,0.0)+bias : dist2;
      if(transitioning && nearest>=0 && hold.identity.x==source_hold(uint(nearest),lowerCount,lower,upper).identity.x) continue;
      // Shaped only: a hold past its own (scaled) reach lights nothing itself.
      // It is set aside and decided after the loop, by plain distance: a
      // neighbour's faint-field bias must never hand it a pixel, or it would cut
      // that neighbour's halo (a ghost beside a lit hold) along its crop box.
      if(shaped && max(sqrt(dist2)-0.5,0.0)>=hold.numbers.x*shape.z) {
        if(dist2<outside) {
          outsideNext=outside;outsiderNext=outsider;
          outside=dist2;outsideBias=bias;outsider=int(index);
        } else if(dist2<outsideNext) {
          outsideNext=dist2;outsiderNext=int(index);
        }
        continue;
      }
      if(score<bestScore) {
        second=best;secondScore=bestScore;runner=nearest;
        best=dist2;bestScore=score;nearest=int(index);
      } else if(score<secondScore && (!transitioning || runner<0 ||
          hold.identity.x!=source_hold(uint(runner),lowerCount,lower,upper).identity.x)) {
        second=dist2;secondScore=score;runner=int(index);
      }
    }
    // Shaped only: the held-back hold, as the still compositor would rank it, so
    // a look frame at W = (1, 0) or (0, 1) draws the still frame exactly. It takes
    // the pixel where it is nearer than the owner's light, as at rest (where it
    // can light only through a same-colour merge), or else it may be the runner.
    // Its own bias fades both as its glow does, so neither ends in a pop, and it
    // takes no pixel past the owner's unscaled reach, which its crop box covers.
    bool scored=transitioning;
    bool outsideRunner=false;
    if(outsider>=0) {
      float outsideScore=max(sqrt(outside)-0.5,0.0)+outsideBias;
      if(nearest<0 || (sqrt(outside)+outsideBias<sqrt(best) &&
          max(sqrt(outside)-0.5,0.0)<source_hold(uint(nearest),lowerCount,lower,upper).numbers.x)) {
        bool nextFirst=outsiderNext>=0 && (nearest<0 || outsideNext<best);
        second=nextFirst ? outsideNext : best;
        runner=nextFirst ? outsiderNext : nearest;
        best=outside;nearest=outsider;scored=false;
      } else if(runner<0 || outsideScore<secondScore) {
        second=outside;secondScore=outsideScore;runner=outsider;outsideRunner=true;
      }
    }
    int coverLocal=crop_index(point,uniforms.coverCrop);
    if(uniforms.offsets.x!=0xffffffffu && coverLocal>=0)
      pixel=stamp_over(pixel,read_rgba(atlas,uniforms.offsets.x+uint(coverLocal)*4)*ambient);
    if(uniforms.size.w > 0 && nearest>=0) {
      Hold hold=source_hold(uint(nearest),lowerCount,lower,upper);
      float4 shape=shaped ? look_hold(look,uint(nearest)) : float4(0);
      float weight=shaped ? shape.y : (transitioning ? reveal_weight(hold,uint(nearest)>=lowerCount,uniforms) : 1);
      float reach=hold.numbers.x*(shaped ? shape.z : (hold.numbers.y>0 ? reachScale : 1));
      float distance=max(sqrt(best)-0.5,0.0);
      float fraction=distance/reach;
      float3 color=hold.color.rgb;
      if(runner>=0) {
        Hold other=source_hold(uint(runner),lowerCount,lower,upper);
        // A held-back runner sits at its plain distance plus its own bias, never
        // pulled closer by the owner's.
        float otherDistance=outsideRunner ? secondScore
          : (scored ? distance+max(secondScore-bestScore,0.0) : max(sqrt(second)-0.5,0.0));
        if(all(other.color.rgb==color)) {
          float softness=uniforms.tuning.x*reach;
          if(softness>0) {
            float h=clamp(0.5+0.5*(otherDistance-distance)/softness,0.0,1.0);
            fraction=min(max(otherDistance*(1-h)+distance*h-softness*h*(1-h),0.0)/reach,1.0);
          }
        } else {
          float band=uniforms.tuning.y*reach;
          float gap=scored && !outsideRunner ? secondScore-bestScore : otherDistance-distance;
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
        alpha*=1-(shaped ? mask : coverage);
        alpha*=weight;
        if(alpha>0.002) pixel=over(pixel,float4(color*alpha,alpha));
      }
    }
    // Preserve CPU layer order across holds: all fills, then all plates,
    // then all glyphs. Combining each hold's layers would change overlaps.
    for(uint layer=1;layer<5;layer++) {
      if((uniforms.offsets.y & (1u << (layer-1u)))==0) continue;
      for(uint ordinal=0;ordinal<candidates;ordinal++) {
        uint index=tile_index(ordinal,lowerRange,upperRange,lowerCount,lut);
        Hold hold=source_hold(index,lowerCount,lower,upper);
        bool annotation=hold.identity.z>0;
        if((layer==4)!=annotation) continue;
        float weight=shaped ? look_hold(look,index).x : (transitioning ? reveal_weight(hold,index>=lowerCount,uniforms) : 1);
        if(weight<=0) continue;
        uint passes=layer==1 ? 4u : (layer>=3 ? 2u : 1u);
        for(uint pass=0;pass<passes;pass++) {
          uint offset;
          uint4 crop;
          if(layer==1) {
            offset=pass==0 ? hold.offsets.y : hold.extraOffsets[pass-1];
            crop=pass==0 ? hold.fillCrop : (pass==1 ? hold.fillCrop1 : (pass==2 ? hold.fillCrop2 : hold.fillCrop3));
          } else if(layer==2) {
            offset=hold.offsets.z;
            crop=hold.plateCrop;
          } else {
            offset=pass==0 ? hold.offsets.w : hold.extraOffsets.w;
            crop=pass==0 ? hold.glyphCrop : hold.glyphCrop1;
          }
          if(offset==0xffffffffu) continue;
          int local=crop_index(point,crop);
          if(local>=0) pixel=stamp_over(pixel,read_rgba(atlas,offset+uint(local)*4)*weight);
        }
      }
    }
    return pixel;
  }
  fragment float4 overlay_fragment(float4 position [[position]],
      device const uchar* atlas [[buffer(\(ClimbOverlayPacketLayout.metalBindingsPixels))]], device const Hold* lower [[buffer(\(ClimbOverlayPacketLayout.metalBindingsLower))]],
      constant Uniforms& uniforms [[buffer(\(ClimbOverlayPacketLayout.metalBindingsUniforms))]], device const float* lut [[buffer(\(ClimbOverlayPacketLayout.metalBindingsResources))]],
      device const Hold* upper [[buffer(\(ClimbOverlayPacketLayout.metalBindingsUpper))]],
      constant ushort4* look [[buffer(5)]]) { // ClimbOverlaySwapLook.metalBinding; always bound
    uint2 point = min(uint2(position.xy / uniforms.viewport.xy * uniforms.size.xy),uint2(uniforms.size.xy)-1);
    float progress=uniforms.motion.x;
    // Exact endpoints use the original still compositor, without weighting.
    if(progress<=0) return scene_pixel(point,atlas,lower,lower,uniforms,lut,uint(uniforms.size.z),0,
      uniforms.tuning2.z,false,uniforms.motion.w,uniforms.offsets.z,0xffffffffu,look,false);
    if(progress>=1) return scene_pixel(point,atlas,upper,upper,uniforms,lut,uint(uniforms.other.x),0,
      uniforms.other.y,false,1,uniforms.offsets.w,0xffffffffu,look,false);
    // One union field, one veil/LED cover pass, one set of mark layers.
    // No geometry or buffers change while the UI-thread progress moves. The
    // swap look replaces reveal_weight only here, and only in swap mode; its
    // header is zero (API 7 path) whenever the app sent no look.
    bool shaped=uniforms.motion.z>0.5 && look[0].x>0;
    return scene_pixel(point,atlas,lower,upper,uniforms,lut,uint(uniforms.size.z),uint(uniforms.other.x),
      max(uniforms.tuning2.z,uniforms.other.y),true,1,uniforms.offsets.z,uniforms.offsets.w,look,shaped);
  }
  """
}
