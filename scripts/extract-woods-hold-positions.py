#!/usr/bin/env python3
"""Extract Woods Board per-hold positions from the Woods app board art.

PROVENANCE for packages/board-constants/src/generated/woods-hold-positions-data.ts.

The Woods board's hold positions are not a uniform grid (the kicker/foot rows are
spread wider than the dense main field), so the on-screen layout is recovered by
CV from the Woods Android app v1.6 board art:
  - 12x12: assets_woodsboardp1.jpg            (3500x4000)
  - 8x10:  assets_woodsboardmaplayout8x10_16.png (1440x2000)
extracted from com.woodsboardapp2 (apktool d / unzip the base APK).

Detection is constrained by the known logical grid (BOARD_ROW_LENGTHS from the
app's index.android.bundle, mirrored in woods-config.ts): global row-band
detection (merge-closest until the exact row count) fixes the non-uniform vertical
pitch, then each hold is snapped to its local 2D centre of mass near the
edge-to-edge column position. ~97% of centres land on a hold.

Usage (needs: pip install Pillow numpy scipy):
  python3 scripts/extract-woods-hold-positions.py 8x10  <path-to-8x10-art.png>  out-8x10.json
  python3 scripts/extract-woods-hold-positions.py 12x12 <path-to-12x12-art.jpg> out-12x12.json
Then bake the two JSON files into woods-hold-positions-data.ts (normalised [x,y]).
"""
import numpy as np
from PIL import Image, ImageDraw
from scipy.signal import find_peaks
from scipy.ndimage import gaussian_filter1d

def row_lengths(size):
    if size=='8x10': return [11]*1 + [21]*21 + [11]*3
    return [17]*3 + [33]*23 + [17]*3 + [17]*1 + [16]*1

def detect(path, size, out_overlay):
    rows = row_lengths(size); nrows=len(rows)
    im = Image.open(path).convert('RGB'); A = np.asarray(im).astype(float); H,W,_=A.shape
    mask = (A.mean(axis=2) < 225).astype(float)
    # --- global row-Y bands ---
    rprof = gaussian_filter1d(mask.sum(axis=1), sigma=H*0.0015)
    pk,props = find_peaks(rprof, distance=H/(nrows*2.2), prominence=rprof.max()*0.008)
    pk=list(pk); prom=list(props['prominences'])
    # merge the closest-adjacent pair until exactly nrows remain (keeps sparse rows)
    while len(pk) > nrows:
        gaps=[pk[i+1]-pk[i] for i in range(len(pk)-1)]
        i=int(np.argmin(gaps))
        w0,w1=prom[i],prom[i+1]; tot=w0+w1 or 1
        pk[i]=int((pk[i]*w0+pk[i+1]*w1)/tot); prom[i]=max(w0,w1)
        del pk[i+1]; del prom[i+1]
    rowY = np.array(sorted(pk))
    # content X bounds (for expected even-X)
    cols_any = mask.sum(axis=0); cprof = gaussian_filter1d(cols_any, sigma=W*0.001)
    xs = np.where(cprof > cprof.max()*0.05)[0]
    xL, xR = xs.min(), xs.max()
    # --- per-hold centroid refine ---
    table = {}; pts=[]
    loc=0
    wy = int(np.median(np.diff(rowY))*0.45) if len(rowY)>1 else int(H*0.02)
    for r in range(min(nrows,len(rowY))):
        L = rows[r]; y0 = rowY[r]
        # per-row column peaks within the strip
        s0=max(0,y0-wy); s1=min(H,y0+wy)
        strip = mask[s0:s1,:].sum(axis=0)
        strip = gaussian_filter1d(strip, sigma=W*0.0015)
        wx = (xR-xL)/(L-1) if L>1 else (xR-xL)
        cpk,cpr = find_peaks(strip, distance=max(3,wx*0.55), prominence=strip.max()*0.05)
        # match each expected col to nearest detected peak; fallback to expected
        for c in range(L):
            ex = xL + (c/(L-1))*(xR-xL) if L>1 else (xL+xR)/2
            gx = ex
            if len(cpk):
                j = np.argmin(np.abs(cpk-ex))
                if abs(cpk[j]-ex) < wx*0.55: gx = cpk[j]
            # 2D centre-of-mass snap in a window around (gx, y0); iterate twice
            cx,cy = gx,float(y0)
            for _ in range(2):
                hw=int(wx*0.42); hh=int(wy*0.9)
                x0=max(0,int(cx)-hw); x1=min(W,int(cx)+hw); ya=max(0,int(cy)-hh); yb=min(H,int(cy)+hh)
                win=mask[ya:yb, x0:x1]
                if win.sum()>0:
                    xs=np.arange(x0,x1); ys=np.arange(ya,yb)
                    cx=(xs*win.sum(axis=0)).sum()/win.sum()
                    cy=(ys*win.sum(axis=1)).sum()/win.sum()
            table[loc] = [round(cx/W,5), round(cy/H,5)]; pts.append((cx,cy)); loc+=1
    # overlay
    d=ImageDraw.Draw(im); rad=max(5,W//240)
    for (px,cy) in pts:
        d.ellipse([px-rad,cy-rad,px+rad,cy+rad], outline=(255,0,0), width=3)
    im.save(out_overlay, quality=85)
    print(f"{size}: rows detected {len(rowY)}/{nrows}, holds {len(table)}/{sum(rows)}, X[{xL}-{xR}] rowY[{rowY[0]}..{rowY[-1]}]")
    return table

size=sys.argv[1]; path=sys.argv[2]; out=sys.argv[3]; tbl=sys.argv[4]
t=detect(path,size,out)
json.dump(t, open(tbl,'w'))
