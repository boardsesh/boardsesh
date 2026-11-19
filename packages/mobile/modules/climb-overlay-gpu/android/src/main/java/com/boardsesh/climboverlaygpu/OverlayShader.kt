package com.boardsesh.climboverlaygpu

/**
 * Same compositor as the Metal implementation, with byte-addressed SSBO reads,
 * as two programs that share [vertex]:
 *
 * - [fragment], the base program, draws every frame without a swap look. Its
 *   source is byte for byte the one main shipped before the look existed
 *   (`OverlayShaderTest` pins it), so those frames meet no new driver code.
 * - [lookFragment] draws only frames with the swap look: [fragment] plus the
 *   look's per-hold numbers, read from uniform block `Look` at binding
 *   [OverlaySwapLook.GLES_BINDING] (a literal here, kept in step by a unit
 *   test, so the shader stays checkable with only the generated layout). A
 *   phone that cannot compile or link it draws every frame with the base
 *   program; the view reports the look unavailable ([OverlaySwapLookProgram]).
 *
 * [lookFragment] is a second copy of [fragment], kept honest by markers that
 * `OverlayShaderTest` reads: every line only the look has sits between a
 * `// look begin` and a `// look end` line, and a base line the look replaces
 * stays in place as a `// base: ` comment (same indentation) just before the
 * block that replaces it. Dropping the blocks and uncommenting the `// base: `
 * lines must give [fragment] byte for byte, so a fix to one program that
 * misses the other fails the test. Mark every look edit that way.
 */
internal object OverlayShader {
    val vertex =
        """
        #version 310 es
        precision highp float;
        void main() {
            vec2 points[3] = vec2[3](vec2(-1.0,-1.0),vec2(3.0,-1.0),vec2(-1.0,3.0));
            gl_Position=vec4(points[gl_VertexID],0.0,1.0);
        }
        """
            .trimIndent()
    val fragment =
        """
        #version 310 es
        precision highp float;
        precision highp int;
          struct Hold {
            vec4 color;
            vec4 bounds;
            uvec4 crop;
            uvec4 offsets;
            vec4 numbers;
            uvec4 identity;
            uvec4 fillCrop;
            uvec4 plateCrop;
            uvec4 glyphCrop;
            uvec4 extraOffsets;
            uvec4 fillCrop1;
            uvec4 fillCrop2;
            uvec4 fillCrop3;
            uvec4 glyphCrop1;
          };
          struct Uniforms {
            vec4 size; // output width, height, active count, draw glow
            vec4 veil;
            vec4 tuning; // merge, seam, max mix, sharpness
            vec4 tuning2; // fringe, core share, active max reach, wall-swap shared-hold weight
            uvec4 offsets; // LED covers, active stamp-layer mask
            vec2 viewport;
            vec2 swapWeights; // wall swap: lower-only and upper-only hold weights
            vec4 motion; // progress, reveal band width, reveal mode (0 wipe, 1 swap), editor reach scale
            vec4 other; // second count, second max reach, empty production source, display mirror
            uvec4 coverCrop;
          };
          layout(std430,binding=${OverlayPacketLayout.GLES_STORAGE_BINDINGS_PIXELS}) readonly buffer Atlas { uint atlas[]; };
          layout(std430,binding=${OverlayPacketLayout.GLES_STORAGE_BINDINGS_LOWER}) readonly buffer Lower { Hold lower[]; };
          layout(std430,binding=${OverlayPacketLayout.GLES_STORAGE_BINDINGS_UPPER}) readonly buffer Upper { Hold upper[]; };
          layout(std430,binding=${OverlayPacketLayout.GLES_STORAGE_BINDINGS_RESOURCES}) readonly buffer Resources { uint resources[]; };
          layout(std140,binding=${OverlayPacketLayout.GLES_UNIFORM_BINDINGS_UNIFORMS}) uniform Parameters { Uniforms uniforms; };
          layout(location=0) out vec4 outputColor;
          vec4 quantize(vec4 pixel) { return round(clamp(pixel,0.0,1.0)*255.0)/255.0; }
          vec4 over(vec4 under, vec4 above) {
            return quantize(above + under * (1.0-above.a));
          }
          // Match tiny-skia lowp source-over for byte stamps; glow retains
          // the float compositor. Preserve rounding at every paint subpass.
          vec4 stamp_over(vec4 under, vec4 above) {
            uvec4 source=uvec4(round(clamp(above,0.0,1.0)*255.0));
            uvec4 destination=uvec4(round(clamp(under,0.0,1.0)*255.0));
            return vec4(min(source+((destination*(255u-source.a)+255u)>>8u),uvec4(255u)))/255.0;
          }
          vec4 read_rgba(uint offset) {
            uint packedRgba = atlas[offset/4u];
            return vec4(packedRgba&255u,(packedRgba>>8u)&255u,(packedRgba>>16u)&255u,(packedRgba>>24u)&255u)/255.0;
          }
          int crop_index(uvec2 point, uvec4 crop) {
            if (point.x < crop.x || point.y < crop.y ||
                point.x >= crop.x+crop.z || point.y >= crop.y+crop.w) return -1;
            return int((point.y-crop.y)*crop.z+point.x-crop.x);
          }
          int index_at(uvec2 point, Hold hold) { return crop_index(point,hold.crop); }
          // Copy into a local before returning. The Adreno 840 compiler (driver
          // 0842.19.13) drops a struct returned straight from the lower buffer,
          // so the lower scene drew nothing: no holds at rest, no outgoing climb (#7749).
          Hold source_hold(uint index, uint lowerCount) {
            Hold hold;
            if(index<lowerCount) hold=lower[index];
            else hold=upper[index-lowerCount];
            return hold;
          }
          uvec2 tile_range(uvec2 point, uint directory, uint count) {
            if(count==0u || directory==0xffffffffu) return uvec2(0u);
            if(directory<${OverlayPacketLayout.LUT_WORDS}u) return uvec2(0xffffffffu,count);
            uint columns=(uint(uniforms.size.x)+${OverlayPacketLayout.TILE_EDGE}u-1u)/${OverlayPacketLayout.TILE_EDGE}u;
            uint tile=(point.y/${OverlayPacketLayout.TILE_EDGE}u)*columns+point.x/${OverlayPacketLayout.TILE_EDGE}u;
            return uvec2(resources[directory+tile*2u],resources[directory+tile*2u+1u]);
          }
          uint tile_index(uint ordinal, uvec2 lowerRange, uvec2 upperRange, uint lowerCount) {
            bool isUpper=ordinal>=lowerRange.y;
            uvec2 range=isUpper ? upperRange : lowerRange;
            uint local=isUpper ? ordinal-lowerRange.y : ordinal;
            return (isUpper ? lowerCount : 0u)+(range.x==0xffffffffu ? local : resources[range.x+local]);
          }
          float reveal_weight(Hold hold, bool upper) {
            float membership=upper ? hold.numbers.z : hold.numbers.w;
            // A shared same-role hold appears only once, on the lower side. The wipe
            // keeps it fully lit; the wall swap gives it the app's shared weight.
            if(membership==1.0) return upper ? 0.0 : (uniforms.motion.z>0.5 ? uniforms.tuning2.w : 1.0);
            // Wall swap: one weight per side, wherever the hold is. A changed hold
            // shows only its stronger role (the lower one on a tie), never two marks.
            if(uniforms.motion.z>0.5) {
              float own=upper ? uniforms.swapWeights.y : uniforms.swapWeights.x;
              float other=upper ? uniforms.swapWeights.x : uniforms.swapWeights.y;
              if(membership==2.0 && (upper ? own<=other : own<other)) return 0.0;
              return own;
            }
            float center=clamp((hold.bounds.x+hold.bounds.z)*0.5/uniforms.size.x,0.0,1.0);
            if(uniforms.other.w>0.0) center=1.0-center;
            float halfBand=uniforms.motion.y*0.5;
            float boundary=1.0+halfBand-uniforms.motion.x*(1.0+2.0*halfBand);
            float reveal=smoothstep(boundary-halfBand,boundary+halfBand,center);
            // One weight for the entire hold, not for each pixel. A changed role
            // goes fully dark before the other role appears: no half-start/half-finish.
            if(membership==2.0) return upper ? max(2.0*reveal-1.0,0.0) : max(1.0-2.0*reveal,0.0);
            return upper ? reveal : 1.0-reveal;
          }
          vec4 scene_pixel(uvec2 point,
              uint lowerCount, uint upperCount, float maxReach, bool transitioning, float reachScale) {
            uint count=lowerCount+upperCount;
            uvec2 lowerRange=tile_range(point,uniforms.offsets.z,lowerCount);
            uvec2 upperRange=tile_range(point,uniforms.offsets.w,upperCount);
            uint candidates=lowerRange.y+upperRange.y;
            // Production empty frames show the bare board, matching the CPU host.
            // Legacy parity diagnostics retain their explicit veil-only empty image.
            if(count==0u && uniforms.other.z>0.0) return vec4(0.0);
            float ambient=transitioning && uniforms.other.z>0.0
              ? mix(lowerCount>0u ? 1.0 : 0.0,upperCount>0u ? 1.0 : 0.0,uniforms.motion.x) : 1.0;
            vec4 pixel = quantize(uniforms.veil*ambient);
            float coverage = 0.0;
            float best = 1e20, second = 1e20;
            float bestScore=1e20, secondScore=1e20;
            int nearest = -1, runner = -1;
            for (uint ordinal=0u;ordinal<candidates;ordinal++) {
              uint index=tile_index(ordinal,lowerRange,upperRange,lowerCount);
              Hold hold = source_hold(index,lowerCount);
              if(hold.identity.z>0u) continue; // Annotation: no silhouette coverage or glow.
              int local = index_at(point,hold);
              if(local < 0) continue;
              float weight=transitioning ? reveal_weight(hold,index>=lowerCount) : 1.0;
              if(weight<=0.0) continue;
              uint field = atlas[hold.offsets.x/4u+uint(local)];
              uint squared = field & 0x00ffffffu;
              float dist2 = squared==0x00ffffffu ? 1e20 : float(squared);
              float alpha = float(field>>24u)/255.0*weight;
              coverage = max(coverage,alpha);
              pixel = quantize(pixel*(1.0-alpha));
              float dilation = ceil(maxReach*(hold.numbers.y>0.0 ? reachScale : 1.0))+2.0;
              // Match the CPU crop for THIS climb, even though the immutable atlas
              // carries enough padding for the widest hold in the layout.
              if(dist2>=1e20 || hold.numbers.x <= 0.0 || float(point.x)<floor(hold.bounds.x-dilation) ||
                 float(point.y)<floor(hold.bounds.y-dilation) || float(point.x)>=ceil(hold.bounds.z+dilation) ||
                 float(point.y)>=ceil(hold.bounds.w+dilation)) continue;
              // Faint incoming fields must not steal an existing glow, even at d=0.
              // Keep real distance for falloff, and use a continuous positive fade
              // bias for ownership and seam interpolation during the reveal only.
              float score=transitioning ? max(sqrt(dist2)-0.5,0.0)+hold.numbers.x*(1.0-weight)/max(weight,0.0001) : dist2;
              if(transitioning && nearest>=0 && hold.identity.x==source_hold(uint(nearest),lowerCount).identity.x) continue;
              if(score<bestScore) {
                second=best;secondScore=bestScore;runner=nearest;
                best=dist2;bestScore=score;nearest=int(index);
              } else if(score<secondScore && (!transitioning || runner<0 ||
                  hold.identity.x!=source_hold(uint(runner),lowerCount).identity.x)) {
                second=dist2;secondScore=score;runner=int(index);
              }
            }
            int coverLocal=crop_index(point,uniforms.coverCrop);
            if(uniforms.offsets.x!=0xffffffffu && coverLocal>=0)
              pixel=stamp_over(pixel,read_rgba(uniforms.offsets.x+uint(coverLocal)*4u)*ambient);
            if(uniforms.size.w > 0.0 && nearest>=0) {
              Hold hold=source_hold(uint(nearest),lowerCount);
              float weight=transitioning ? reveal_weight(hold,uint(nearest)>=lowerCount) : 1.0;
              float reach=hold.numbers.x*(hold.numbers.y>0.0 ? reachScale : 1.0);
              float distance=max(sqrt(best)-0.5,0.0);
              float fraction=distance/reach;
              vec3 color=hold.color.rgb;
              if(runner>=0) {
                Hold other=source_hold(uint(runner),lowerCount);
                float otherDistance=transitioning ? distance+max(secondScore-bestScore,0.0) : max(sqrt(second)-0.5,0.0);
                if(all(equal(other.color.rgb,color))) {
                  float softness=uniforms.tuning.x*reach;
                  if(softness>0.0) {
                    float h=clamp(0.5+0.5*(otherDistance-distance)/softness,0.0,1.0);
                    fraction=min(max(otherDistance*(1.0-h)+distance*h-softness*h*(1.0-h),0.0)/reach,1.0);
                  }
                } else {
                  float band=uniforms.tuning.y*reach;
                  float gap=transitioning ? secondScore-bestScore : otherDistance-distance;
                  if(band>0.0 && gap<band) {
                    float closeness=clamp(1.0-gap/band,0.0,1.0);
                    float amount=uniforms.tuning.z*pow(closeness,uniforms.tuning.w);
                    color=round(mix(color,other.color.rgb,amount)*255.0)/255.0;
                  }
                }
              }
              if(fraction<1.0) {
                float at=clamp(fraction,0.0,1.0)*256.0;
                uint index=min(uint(at),255u);
                float alpha=mix(uintBitsToFloat(resources[index]),uintBitsToFloat(resources[index+1u]),at-float(index));
                float deepen=uniforms.tuning2.x*smoothstep(uniforms.tuning2.y,1.0,fraction);
                vec3 deep=round(hold.color.rgb*255.0*0.35)/255.0;
                color=round(mix(color,deep,deepen)*255.0)/255.0;
                alpha*=1.0-coverage;
                alpha*=weight;
                if(alpha>0.002) pixel=over(pixel,vec4(color*alpha,alpha));
              }
            }
            // Preserve CPU layer order across holds: all fills, then all plates,
            // then all glyphs. Combining each hold's layers would change overlaps.
            for(uint layer=1u;layer<5u;layer++) {
              if((uniforms.offsets.y & (1u << (layer-1u)))==0u) continue;
              for(uint ordinal=0u;ordinal<candidates;ordinal++) {
                uint index=tile_index(ordinal,lowerRange,upperRange,lowerCount);
                Hold hold=source_hold(index,lowerCount);
                bool annotation=hold.identity.z>0u;
                if((layer==4u)!=annotation) continue;
                float weight=transitioning ? reveal_weight(hold,index>=lowerCount) : 1.0;
                if(weight<=0.0) continue;
                uint passes=layer==1u ? 4u : (layer>=3u ? 2u : 1u);
                for(uint pass=0u;pass<passes;pass++) {
                  uint offset;
                  uvec4 crop;
                  if(layer==1u) {
                    offset=pass==0u ? hold.offsets.y : hold.extraOffsets[pass-1u];
                    crop=pass==0u ? hold.fillCrop : (pass==1u ? hold.fillCrop1 : (pass==2u ? hold.fillCrop2 : hold.fillCrop3));
                  } else if(layer==2u) {
                    offset=hold.offsets.z;
                    crop=hold.plateCrop;
                  } else {
                    offset=pass==0u ? hold.offsets.w : hold.extraOffsets.w;
                    crop=pass==0u ? hold.glyphCrop : hold.glyphCrop1;
                  }
                  if(offset==0xffffffffu) continue;
                  int local=crop_index(point,crop);
                  if(local>=0) pixel=stamp_over(pixel,read_rgba(offset+uint(local)*4u)*weight);
                }
              }
            }
            return pixel;
          }
          void main() {
            // GL framebuffer origin is bottom-left; Rust/Metal atlas rows are top-left.
            uvec2 point = min(uvec2(vec2(gl_FragCoord.x,uniforms.viewport.y-gl_FragCoord.y)
              / uniforms.viewport.xy * uniforms.size.xy),uvec2(uniforms.size.xy)-1u);
            float progress=uniforms.motion.x;
            if(progress<=0.0) outputColor=scene_pixel(point,uint(uniforms.size.z),0u,uniforms.tuning2.z,false,uniforms.motion.w);
            else if(progress>=1.0) outputColor=scene_pixel(point,0u,uint(uniforms.other.x),uniforms.other.y,false,1.0);
            else outputColor=scene_pixel(point,uint(uniforms.size.z),uint(uniforms.other.x),
              max(uniforms.tuning2.z,uniforms.other.y),true,1.0);
          }

        """
            .trimIndent()

    /**
     * The swap look's program: [fragment] with the look's per-hold mark, glow
     * and reach (`look_hold`), each look edit marked (see the class comment).
     */
    val lookFragment =
        """
        #version 310 es
        precision highp float;
        precision highp int;
          struct Hold {
            vec4 color;
            vec4 bounds;
            uvec4 crop;
            uvec4 offsets;
            vec4 numbers;
            uvec4 identity;
            uvec4 fillCrop;
            uvec4 plateCrop;
            uvec4 glyphCrop;
            uvec4 extraOffsets;
            uvec4 fillCrop1;
            uvec4 fillCrop2;
            uvec4 fillCrop3;
            uvec4 glyphCrop1;
          };
          struct Uniforms {
            vec4 size; // output width, height, active count, draw glow
            vec4 veil;
            vec4 tuning; // merge, seam, max mix, sharpness
            vec4 tuning2; // fringe, core share, active max reach, wall-swap shared-hold weight
            uvec4 offsets; // LED covers, active stamp-layer mask
            vec2 viewport;
            vec2 swapWeights; // wall swap: lower-only and upper-only hold weights
            vec4 motion; // progress, reveal band width, reveal mode (0 wipe, 1 swap), editor reach scale
            vec4 other; // second count, second max reach, empty production source, display mirror
            uvec4 coverCrop;
          };
          layout(std430,binding=${OverlayPacketLayout.GLES_STORAGE_BINDINGS_PIXELS}) readonly buffer Atlas { uint atlas[]; };
          layout(std430,binding=${OverlayPacketLayout.GLES_STORAGE_BINDINGS_LOWER}) readonly buffer Lower { Hold lower[]; };
          layout(std430,binding=${OverlayPacketLayout.GLES_STORAGE_BINDINGS_UPPER}) readonly buffer Upper { Hold upper[]; };
          layout(std430,binding=${OverlayPacketLayout.GLES_STORAGE_BINDINGS_RESOURCES}) readonly buffer Resources { uint resources[]; };
          layout(std140,binding=${OverlayPacketLayout.GLES_UNIFORM_BINDINGS_UNIFORMS}) uniform Parameters { Uniforms uniforms; };
          // look begin
          // Swap look (swapLookVersion 2): Metal's fragment buffer 5, byte for byte. One
          // 16-bit (mark, glow, reach, 0) per union hold after a header; std140 gives each
          // array element 16 bytes, so two holds share a uvec4. Bound with every draw of
          // this program, which the renderer uses only for a frame that draws the look.
          layout(std140,binding=1) uniform Look { uvec4 look[129]; };
          // look end
          layout(location=0) out vec4 outputColor;
          vec4 quantize(vec4 pixel) { return round(clamp(pixel,0.0,1.0)*255.0)/255.0; }
          vec4 over(vec4 under, vec4 above) {
            return quantize(above + under * (1.0-above.a));
          }
          // Match tiny-skia lowp source-over for byte stamps; glow retains
          // the float compositor. Preserve rounding at every paint subpass.
          vec4 stamp_over(vec4 under, vec4 above) {
            uvec4 source=uvec4(round(clamp(above,0.0,1.0)*255.0));
            uvec4 destination=uvec4(round(clamp(under,0.0,1.0)*255.0));
            return vec4(min(source+((destination*(255u-source.a)+255u)>>8u),uvec4(255u)))/255.0;
          }
          vec4 read_rgba(uint offset) {
            uint packedRgba = atlas[offset/4u];
            return vec4(packedRgba&255u,(packedRgba>>8u)&255u,(packedRgba>>16u)&255u,(packedRgba>>24u)&255u)/255.0;
          }
          int crop_index(uvec2 point, uvec4 crop) {
            if (point.x < crop.x || point.y < crop.y ||
                point.x >= crop.x+crop.z || point.y >= crop.y+crop.w) return -1;
            return int((point.y-crop.y)*crop.z+point.x-crop.x);
          }
          int index_at(uvec2 point, Hold hold) { return crop_index(point,hold.crop); }
          // Copy into a local before returning. The Adreno 840 compiler (driver
          // 0842.19.13) drops a struct returned straight from the lower buffer,
          // so the lower scene drew nothing: no holds at rest, no outgoing climb (#7749).
          Hold source_hold(uint index, uint lowerCount) {
            Hold hold;
            if(index<lowerCount) hold=lower[index];
            else hold=upper[index-lowerCount];
            return hold;
          }
          uvec2 tile_range(uvec2 point, uint directory, uint count) {
            if(count==0u || directory==0xffffffffu) return uvec2(0u);
            if(directory<${OverlayPacketLayout.LUT_WORDS}u) return uvec2(0xffffffffu,count);
            uint columns=(uint(uniforms.size.x)+${OverlayPacketLayout.TILE_EDGE}u-1u)/${OverlayPacketLayout.TILE_EDGE}u;
            uint tile=(point.y/${OverlayPacketLayout.TILE_EDGE}u)*columns+point.x/${OverlayPacketLayout.TILE_EDGE}u;
            return uvec2(resources[directory+tile*2u],resources[directory+tile*2u+1u]);
          }
          uint tile_index(uint ordinal, uvec2 lowerRange, uvec2 upperRange, uint lowerCount) {
            bool isUpper=ordinal>=lowerRange.y;
            uvec2 range=isUpper ? upperRange : lowerRange;
            uint local=isUpper ? ordinal-lowerRange.y : ordinal;
            return (isUpper ? lowerCount : 0u)+(range.x==0xffffffffu ? local : resources[range.x+local]);
          }
          float reveal_weight(Hold hold, bool upper) {
            float membership=upper ? hold.numbers.z : hold.numbers.w;
            // A shared same-role hold appears only once, on the lower side. The wipe
            // keeps it fully lit; the wall swap gives it the app's shared weight.
            if(membership==1.0) return upper ? 0.0 : (uniforms.motion.z>0.5 ? uniforms.tuning2.w : 1.0);
            // Wall swap: one weight per side, wherever the hold is. A changed hold
            // shows only its stronger role (the lower one on a tie), never two marks.
            if(uniforms.motion.z>0.5) {
              float own=upper ? uniforms.swapWeights.y : uniforms.swapWeights.x;
              float other=upper ? uniforms.swapWeights.x : uniforms.swapWeights.y;
              if(membership==2.0 && (upper ? own<=other : own<other)) return 0.0;
              return own;
            }
            float center=clamp((hold.bounds.x+hold.bounds.z)*0.5/uniforms.size.x,0.0,1.0);
            if(uniforms.other.w>0.0) center=1.0-center;
            float halfBand=uniforms.motion.y*0.5;
            float boundary=1.0+halfBand-uniforms.motion.x*(1.0+2.0*halfBand);
            float reveal=smoothstep(boundary-halfBand,boundary+halfBand,center);
            // One weight for the entire hold, not for each pixel. A changed role
            // goes fully dark before the other role appears: no half-start/half-finish.
            if(membership==2.0) return upper ? max(2.0*reveal-1.0,0.0) : max(1.0-2.0*reveal,0.0);
            return upper ? reveal : 1.0-reveal;
          }
          // look begin
          // Mark and glow weights in 1/65535 steps, glow reach in 1/32768 (reach 1
          // decodes exactly), scaled as Metal scales its ushort4.
          vec4 look_hold(uint index) {
            uint slot=1u+index;
            uvec4 pair=look[slot>>1u];
            uvec2 words=(slot&1u)==0u ? pair.xy : pair.zw;
            return vec4(float(words.x&0xffffu),float(words.x>>16u),float(words.y&0xffffu),0.0)
              *vec4(1.0/65535.0,1.0/65535.0,1.0/32768.0,0.0);
          }
          // look end
          vec4 scene_pixel(uvec2 point,
              // base: uint lowerCount, uint upperCount, float maxReach, bool transitioning, float reachScale) {
              // look begin
              uint lowerCount, uint upperCount, float maxReach, bool transitioning, float reachScale, bool shaped) {
              // look end
            uint count=lowerCount+upperCount;
            uvec2 lowerRange=tile_range(point,uniforms.offsets.z,lowerCount);
            uvec2 upperRange=tile_range(point,uniforms.offsets.w,upperCount);
            uint candidates=lowerRange.y+upperRange.y;
            // Production empty frames show the bare board, matching the CPU host.
            // Legacy parity diagnostics retain their explicit veil-only empty image.
            if(count==0u && uniforms.other.z>0.0) return vec4(0.0);
            float ambient=transitioning && uniforms.other.z>0.0
              ? mix(lowerCount>0u ? 1.0 : 0.0,upperCount>0u ? 1.0 : 0.0,uniforms.motion.x) : 1.0;
            vec4 pixel = quantize(uniforms.veil*ambient);
            float coverage = 0.0;
            // look begin
            // Shaped only: every visible hold's silhouette, so a halo never paints inside
            // a hold whose mark is fainter than its glow (a ghost). It comes in over a
            // hold's first 0.1 of glow, so a neighbour's halo never vanishes from inside
            // a ghost in one frame. Equal to coverage whenever every mark is whole.
            float mask = 0.0;
            // look end
            float best = 1e20, second = 1e20;
            float bestScore=1e20, secondScore=1e20;
            int nearest = -1, runner = -1;
            // look begin
            // Shaped only: the two nearest visible holds past their own reach, by plain
            // distance, and the nearest one's faint-field bias.
            float outside=1e20, outsideNext=1e20, outsideBias=0.0;
            int outsider=-1, outsiderNext=-1;
            // look end
            for (uint ordinal=0u;ordinal<candidates;ordinal++) {
              uint index=tile_index(ordinal,lowerRange,upperRange,lowerCount);
              Hold hold = source_hold(index,lowerCount);
              if(hold.identity.z>0u) continue; // Annotation: no silhouette coverage or glow.
              int local = index_at(point,hold);
              if(local < 0) continue;
              // base: float weight=transitioning ? reveal_weight(hold,index>=lowerCount) : 1.0;
              // base: if(weight<=0.0) continue;
              // look begin
              vec4 shape=shaped ? look_hold(index) : vec4(0.0);
              float weight=shaped ? shape.x : (transitioning ? reveal_weight(hold,index>=lowerCount) : 1.0);
              float glowWeight=shaped ? shape.y : weight;
              if(glowWeight<=0.0) continue;
              // look end
              uint field = atlas[hold.offsets.x/4u+uint(local)];
              uint squared = field & 0x00ffffffu;
              float dist2 = squared==0x00ffffffu ? 1e20 : float(squared);
              float alpha = float(field>>24u)/255.0*weight;
              coverage = max(coverage,alpha);
              // look begin
              if(shaped) mask=max(mask,float(field>>24u)/255.0*clamp(glowWeight*10.0,0.0,1.0));
              // look end
              pixel = quantize(pixel*(1.0-alpha));
              // base: float dilation = ceil(maxReach*(hold.numbers.y>0.0 ? reachScale : 1.0))+2.0;
              // look begin
              // Shaped: never smaller than the still crop, so a hold whose halo pulls in
              // keeps the pixels it could still own at rest.
              float dilation = ceil(maxReach*(shaped ? max(shape.z,1.0) : (hold.numbers.y>0.0 ? reachScale : 1.0)))+2.0;
              // look end
              // Match the CPU crop for THIS climb, even though the immutable atlas
              // carries enough padding for the widest hold in the layout.
              if(dist2>=1e20 || hold.numbers.x <= 0.0 || float(point.x)<floor(hold.bounds.x-dilation) ||
                 float(point.y)<floor(hold.bounds.y-dilation) || float(point.x)>=ceil(hold.bounds.z+dilation) ||
                 float(point.y)>=ceil(hold.bounds.w+dilation)) continue;
              // Faint incoming fields must not steal an existing glow, even at d=0.
              // Keep real distance for falloff, and use a continuous positive fade
              // bias for ownership and seam interpolation during the reveal only.
              // base: float score=transitioning ? max(sqrt(dist2)-0.5,0.0)+hold.numbers.x*(1.0-weight)/max(weight,0.0001) : dist2;
              // look begin
              float bias=hold.numbers.x*(1.0-glowWeight)/max(glowWeight,0.0001);
              float score=transitioning ? max(sqrt(dist2)-0.5,0.0)+bias : dist2;
              // look end
              if(transitioning && nearest>=0 && hold.identity.x==source_hold(uint(nearest),lowerCount).identity.x) continue;
              // look begin
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
              // look end
              if(score<bestScore) {
                second=best;secondScore=bestScore;runner=nearest;
                best=dist2;bestScore=score;nearest=int(index);
              } else if(score<secondScore && (!transitioning || runner<0 ||
                  hold.identity.x!=source_hold(uint(runner),lowerCount).identity.x)) {
                second=dist2;secondScore=score;runner=int(index);
              }
            }
            // look begin
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
                  max(sqrt(outside)-0.5,0.0)<source_hold(uint(nearest),lowerCount).numbers.x)) {
                bool nextFirst=outsiderNext>=0 && (nearest<0 || outsideNext<best);
                second=nextFirst ? outsideNext : best;
                runner=nextFirst ? outsiderNext : nearest;
                best=outside;nearest=outsider;scored=false;
              } else if(runner<0 || outsideScore<secondScore) {
                second=outside;secondScore=outsideScore;runner=outsider;outsideRunner=true;
              }
            }
            // look end
            int coverLocal=crop_index(point,uniforms.coverCrop);
            if(uniforms.offsets.x!=0xffffffffu && coverLocal>=0)
              pixel=stamp_over(pixel,read_rgba(uniforms.offsets.x+uint(coverLocal)*4u)*ambient);
            if(uniforms.size.w > 0.0 && nearest>=0) {
              Hold hold=source_hold(uint(nearest),lowerCount);
              // base: float weight=transitioning ? reveal_weight(hold,uint(nearest)>=lowerCount) : 1.0;
              // base: float reach=hold.numbers.x*(hold.numbers.y>0.0 ? reachScale : 1.0);
              // look begin
              vec4 shape=shaped ? look_hold(uint(nearest)) : vec4(0.0);
              float weight=shaped ? shape.y : (transitioning ? reveal_weight(hold,uint(nearest)>=lowerCount) : 1.0);
              float reach=hold.numbers.x*(shaped ? shape.z : (hold.numbers.y>0.0 ? reachScale : 1.0));
              // look end
              float distance=max(sqrt(best)-0.5,0.0);
              float fraction=distance/reach;
              vec3 color=hold.color.rgb;
              if(runner>=0) {
                Hold other=source_hold(uint(runner),lowerCount);
                // base: float otherDistance=transitioning ? distance+max(secondScore-bestScore,0.0) : max(sqrt(second)-0.5,0.0);
                // look begin
                // A held-back runner sits at its plain distance plus its own bias, never
                // pulled closer by the owner's.
                float otherDistance=outsideRunner ? secondScore
                  : (scored ? distance+max(secondScore-bestScore,0.0) : max(sqrt(second)-0.5,0.0));
                // look end
                if(all(equal(other.color.rgb,color))) {
                  float softness=uniforms.tuning.x*reach;
                  if(softness>0.0) {
                    float h=clamp(0.5+0.5*(otherDistance-distance)/softness,0.0,1.0);
                    fraction=min(max(otherDistance*(1.0-h)+distance*h-softness*h*(1.0-h),0.0)/reach,1.0);
                  }
                } else {
                  float band=uniforms.tuning.y*reach;
                  // base: float gap=transitioning ? secondScore-bestScore : otherDistance-distance;
                  // look begin
                  float gap=scored && !outsideRunner ? secondScore-bestScore : otherDistance-distance;
                  // look end
                  if(band>0.0 && gap<band) {
                    float closeness=clamp(1.0-gap/band,0.0,1.0);
                    float amount=uniforms.tuning.z*pow(closeness,uniforms.tuning.w);
                    color=round(mix(color,other.color.rgb,amount)*255.0)/255.0;
                  }
                }
              }
              if(fraction<1.0) {
                float at=clamp(fraction,0.0,1.0)*256.0;
                uint index=min(uint(at),255u);
                float alpha=mix(uintBitsToFloat(resources[index]),uintBitsToFloat(resources[index+1u]),at-float(index));
                float deepen=uniforms.tuning2.x*smoothstep(uniforms.tuning2.y,1.0,fraction);
                vec3 deep=round(hold.color.rgb*255.0*0.35)/255.0;
                color=round(mix(color,deep,deepen)*255.0)/255.0;
                // base: alpha*=1.0-coverage;
                // look begin
                alpha*=1.0-(shaped ? mask : coverage);
                // look end
                alpha*=weight;
                if(alpha>0.002) pixel=over(pixel,vec4(color*alpha,alpha));
              }
            }
            // Preserve CPU layer order across holds: all fills, then all plates,
            // then all glyphs. Combining each hold's layers would change overlaps.
            for(uint layer=1u;layer<5u;layer++) {
              if((uniforms.offsets.y & (1u << (layer-1u)))==0u) continue;
              for(uint ordinal=0u;ordinal<candidates;ordinal++) {
                uint index=tile_index(ordinal,lowerRange,upperRange,lowerCount);
                Hold hold=source_hold(index,lowerCount);
                bool annotation=hold.identity.z>0u;
                if((layer==4u)!=annotation) continue;
                // base: float weight=transitioning ? reveal_weight(hold,index>=lowerCount) : 1.0;
                // look begin
                float weight=shaped ? look_hold(index).x : (transitioning ? reveal_weight(hold,index>=lowerCount) : 1.0);
                // look end
                if(weight<=0.0) continue;
                uint passes=layer==1u ? 4u : (layer>=3u ? 2u : 1u);
                for(uint pass=0u;pass<passes;pass++) {
                  uint offset;
                  uvec4 crop;
                  if(layer==1u) {
                    offset=pass==0u ? hold.offsets.y : hold.extraOffsets[pass-1u];
                    crop=pass==0u ? hold.fillCrop : (pass==1u ? hold.fillCrop1 : (pass==2u ? hold.fillCrop2 : hold.fillCrop3));
                  } else if(layer==2u) {
                    offset=hold.offsets.z;
                    crop=hold.plateCrop;
                  } else {
                    offset=pass==0u ? hold.offsets.w : hold.extraOffsets.w;
                    crop=pass==0u ? hold.glyphCrop : hold.glyphCrop1;
                  }
                  if(offset==0xffffffffu) continue;
                  int local=crop_index(point,crop);
                  if(local>=0) pixel=stamp_over(pixel,read_rgba(offset+uint(local)*4u)*weight);
                }
              }
            }
            return pixel;
          }
          void main() {
            // GL framebuffer origin is bottom-left; Rust/Metal atlas rows are top-left.
            uvec2 point = min(uvec2(vec2(gl_FragCoord.x,uniforms.viewport.y-gl_FragCoord.y)
              / uniforms.viewport.xy * uniforms.size.xy),uvec2(uniforms.size.xy)-1u);
            float progress=uniforms.motion.x;
            // base: if(progress<=0.0) outputColor=scene_pixel(point,uint(uniforms.size.z),0u,uniforms.tuning2.z,false,uniforms.motion.w);
            // base: else if(progress>=1.0) outputColor=scene_pixel(point,0u,uint(uniforms.other.x),uniforms.other.y,false,1.0);
            // base: else outputColor=scene_pixel(point,uint(uniforms.size.z),uint(uniforms.other.x),
              // base: max(uniforms.tuning2.z,uniforms.other.y),true,1.0);
            // look begin
            if(progress<=0.0) outputColor=scene_pixel(point,uint(uniforms.size.z),0u,uniforms.tuning2.z,false,uniforms.motion.w,false);
            else if(progress>=1.0) outputColor=scene_pixel(point,0u,uint(uniforms.other.x),uniforms.other.y,false,1.0,false);
            else {
              // The swap look replaces reveal_weight only here, and only in swap mode; a zero
              // header draws the base program's API 7 path.
              bool shaped=uniforms.motion.z>0.5 && (look[0].x&0xffffu)>0u;
              outputColor=scene_pixel(point,uint(uniforms.size.z),uint(uniforms.other.x),
                max(uniforms.tuning2.z,uniforms.other.y),true,1.0,shaped);
            }
            // look end
          }

        """
            .trimIndent()
}
