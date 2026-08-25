#!/bin/bash
# Convert all PNG board images to WebP format.
# Requires: cwebp (brew install webp)
#
# Usage: bash packages/web/scripts/convert-to-webp.sh
# Run from the repo root.
#
# WHY WebP INSTEAD OF AVIF:
# iOS 18.x WebKit has an AVIF decoder bug that causes horizontal image compression.
# WebP does not have this bug and has comparable file sizes. See GitHub issue
# boardsesh/boardsesh#1182 for the plan to re-evaluate AVIF once iOS 18.x adoption drops.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_DIR="$SCRIPT_DIR/../public"

# Quality 80 for WebP gives comparable visual quality to AVIF q65 / PNG
QUALITY=80

converted=0
skipped=0
total_png_size=0
total_webp_size=0

convert_file() {
  local png_file="$1"
  local webp_file="${png_file%.png}.webp"

  # Skip if webp exists and is newer than the png source
  if [[ -f "$webp_file" && "$webp_file" -nt "$png_file" ]]; then
    skipped=$((skipped + 1))
    return
  fi

  cwebp -q "$QUALITY" "$png_file" -o "$webp_file" -quiet

  local png_size webp_size
  png_size=$(stat -f%z "$png_file" 2>/dev/null || stat -c%s "$png_file")
  webp_size=$(stat -f%z "$webp_file" 2>/dev/null || stat -c%s "$webp_file")

  total_png_size=$((total_png_size + png_size))
  total_webp_size=$((total_webp_size + webp_size))
  converted=$((converted + 1))

  local savings=$(( (png_size - webp_size) * 100 / png_size ))
  echo "  $(basename "$png_file") → $(basename "$webp_file")  (${savings}% smaller)"
}

echo "Converting board images to WebP (quality=$QUALITY)..."
echo ""

# Kilter board images
echo "Kilter:"
for f in "$PUBLIC_DIR"/images/kilter/product_sizes_layouts_sets/*.png; do
  [[ -f "$f" ]] && convert_file "$f"
done
echo ""

# Tension board images
echo "Tension:"
for f in "$PUBLIC_DIR"/images/tension/product_sizes_layouts_sets/*.png; do
  [[ -f "$f" ]] && convert_file "$f"
done
echo ""

# Grasshopper board images
echo "Grasshopper:"
for f in "$PUBLIC_DIR"/images/grasshopper/product_sizes_layouts_sets/*.png; do
  [[ -f "$f" ]] && convert_file "$f"
done
echo ""

# Decoy board images
echo "Decoy:"
for f in "$PUBLIC_DIR"/images/decoy/product_sizes_layouts_sets/*.png; do
  [[ -f "$f" ]] && convert_file "$f"
done
echo ""

# Touchstone board images
echo "Touchstone:"
for f in "$PUBLIC_DIR"/images/touchstone/product_sizes_layouts_sets/*.png; do
  [[ -f "$f" ]] && convert_file "$f"
done
echo ""

# So-iLL board images
echo "So-iLL:"
for f in "$PUBLIC_DIR"/images/soill/product_sizes_layouts_sets/*.png; do
  [[ -f "$f" ]] && convert_file "$f"
done
echo ""

# MoonBoard images (recursive)
echo "MoonBoard:"
while IFS= read -r -d '' f; do
  convert_file "$f"
done < <(find "$PUBLIC_DIR/images/moonboard" -name "*.png" -print0)
echo ""

# Woods board images
echo "Woods:"
for f in "$PUBLIC_DIR"/images/woods/*.png; do
  [[ -f "$f" ]] && convert_file "$f"
done
echo ""

# Summary
echo "---"
echo "Converted: $converted files"
echo "Skipped (already up to date): $skipped files"
if [[ $converted -gt 0 ]]; then
  total_savings=$(( (total_png_size - total_webp_size) * 100 / total_png_size ))
  echo "PNG total:  $((total_png_size / 1024)) KB"
  echo "WebP total: $((total_webp_size / 1024)) KB"
  echo "Savings:    ${total_savings}%"
fi
