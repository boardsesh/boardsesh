#!/bin/bash
# Generate thumbnail-sized WebP images for board thumbnails.
# Resizes PNGs to max 416px wide (2x retina for 208px containers) and encodes as WebP.
# Requires: sips (macOS built-in), cwebp (brew install webp)
#
# Usage: bash packages/web/scripts/generate-thumbnails.sh
# Run from the repo root.
#
# WHY WebP INSTEAD OF AVIF:
# iOS 18.x (WebKit) has an AVIF decoder bug that reports incorrect intrinsic image dimensions.
# When a board background image is decoded with wrong dimensions, Safari stretches it to fill
# its container — compressing the image horizontally across every rendering path (SVG <image>,
# canvas WASM compositing, and SSR <img> elements). The bug manifests on all iOS 18.x devices
# running the Capacitor WKWebView. WebP does not have this bug, has comparable file sizes to
# AVIF (both ~75-80% smaller than PNG), and is universally supported on all target platforms.
# We switched from AVIF to WebP in April 2026 to fix this iOS compression bug.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_DIR="$SCRIPT_DIR/../public"

MAX_WIDTH=416
QUALITY=75

converted=0
skipped=0
total_size=0

convert_thumbnail() {
  local png_file="$1"
  local dir="$(dirname "$png_file")"
  local basename="$(basename "$png_file" .png)"
  local thumbs_dir="$dir/thumbs"
  local webp_file="$thumbs_dir/$basename.webp"

  mkdir -p "$thumbs_dir"

  # Skip if thumbnail exists and is newer than source
  if [[ -f "$webp_file" && "$webp_file" -nt "$png_file" ]]; then
    skipped=$((skipped + 1))
    return
  fi

  # Create temp resized PNG
  local tmp_png
  tmp_png=$(mktemp /tmp/thumb_XXXXXX.png)
  cp "$png_file" "$tmp_png"

  # Get current width
  local cur_width
  cur_width=$(sips -g pixelWidth "$tmp_png" 2>/dev/null | awk '/pixelWidth/{print $2}')

  # Only resize if wider than target
  if [[ "$cur_width" -gt "$MAX_WIDTH" ]]; then
    sips --resampleWidth "$MAX_WIDTH" "$tmp_png" --out "$tmp_png" >/dev/null 2>&1
  fi

  # Encode to WebP
  cwebp -q "$QUALITY" "$tmp_png" -o "$webp_file" -quiet

  local webp_size
  webp_size=$(stat -f%z "$webp_file" 2>/dev/null || stat -c%s "$webp_file")
  total_size=$((total_size + webp_size))
  converted=$((converted + 1))

  rm -f "$tmp_png"
  echo "  $(basename "$png_file") → thumbs/$basename.webp  ($(( webp_size / 1024 ))KB)"
}

echo "Generating thumbnail WebPs (max ${MAX_WIDTH}px wide, quality=$QUALITY)..."
echo ""

# Kilter board images
echo "Kilter:"
for f in "$PUBLIC_DIR"/images/kilter/product_sizes_layouts_sets/*.png; do
  [[ -f "$f" ]] && convert_thumbnail "$f"
done
echo ""

# Tension board images
echo "Tension:"
for f in "$PUBLIC_DIR"/images/tension/product_sizes_layouts_sets/*.png; do
  [[ -f "$f" ]] && convert_thumbnail "$f"
done
echo ""

# Grasshopper board images
echo "Grasshopper:"
for f in "$PUBLIC_DIR"/images/grasshopper/product_sizes_layouts_sets/*.png; do
  [[ -f "$f" ]] && convert_thumbnail "$f"
done
echo ""

# Decoy board images
echo "Decoy:"
for f in "$PUBLIC_DIR"/images/decoy/product_sizes_layouts_sets/*.png; do
  [[ -f "$f" ]] && convert_thumbnail "$f"
done
echo ""

# Touchstone board images
echo "Touchstone:"
for f in "$PUBLIC_DIR"/images/touchstone/product_sizes_layouts_sets/*.png; do
  [[ -f "$f" ]] && convert_thumbnail "$f"
done
echo ""

# So-iLL board images
echo "So-iLL:"
for f in "$PUBLIC_DIR"/images/soill/product_sizes_layouts_sets/*.png; do
  [[ -f "$f" ]] && convert_thumbnail "$f"
done
echo ""

# MoonBoard images (recursive)
echo "MoonBoard:"
while IFS= read -r -d '' f; do
  convert_thumbnail "$f"
done < <(find "$PUBLIC_DIR/images/moonboard" -name "*.png" -print0)
echo ""

# Woods board images
echo "Woods:"
for f in "$PUBLIC_DIR"/images/woods/*.png; do
  [[ -f "$f" ]] && convert_thumbnail "$f"
done
echo ""

# Summary
echo "---"
echo "Converted: $converted files"
echo "Skipped (already up to date): $skipped files"
if [[ $converted -gt 0 ]]; then
  echo "Total thumbnail size: $((total_size / 1024)) KB"
fi
