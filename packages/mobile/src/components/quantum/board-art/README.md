# Quantum board artwork

The eight bundled WebPs come from four image members of the eWalls Android
2.6.5 (552) base APK. [Provenance](provenance.json) records the APK, original image
members, source geometry snapshot, and bundled file SHA-256 digests. It also
records the original pixel sizes, crop rectangles, and derivative sizes.

Crop rectangles use zero-based `[left, top, right, bottom]` pixel coordinates
with exclusive right and bottom edges. Full-size WebPs decode to the same
pixels as the corresponding source crops. Thumbnails use Lanczos resampling
to exactly one quarter of each dimension and lossy WebP encoding.

The display transform registers source hold coordinates against dark centres
of visible hold apertures in the original images. Apertures were located with
a difference-of-Gaussians filter. Wall anchors with AutoCAD IDs divisible by
five were withheld to measure fit error. The recorded residuals use original
image pixels. Standard boards share one transform for XL, L, and M. S Fitness
uses a separate transform with independent horizontal and vertical scales.

For raw source coordinates, the original pixel coordinate is
`(x * scaleX + offsetX, offsetY - y * scaleY)`. Subtract the crop's left and
top to get cropped pixels. The mobile implementation uses the same transform
with the geometry's 1,000-fold coordinate scaling. Kicker targets retain the
standard fit. The visible screw holes and apertures there did not establish
LED alignment. The optical fit measures image registration only.

See [the calibration used by the renderer](../../../lib/quantum-art-projection.ts)
and [the fixed geometry snapshot](../../../../../../docs/quantum-board-geometry/catalogue-snapshot.json).
