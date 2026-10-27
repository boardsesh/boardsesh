#ifndef AMOLED_PREVIEW_GEOMETRY_H
#define AMOLED_PREVIEW_GEOMETRY_H

#include <algorithm>
#include <stdint.h>

namespace amoled_preview {

struct Geometry {
    int sourceWidth = 0;
    int sourceHeight = 0;
    int width = 0;
    int height = 0;
    int offsetX = 0;
    int offsetY = 0;
    int numerator = 0;
    int denominator = 1;

    int coordinate(int sourceCoordinate) const { return sourceCoordinate * numerator / denominator; }
    int boundary(int sourceCoordinate) const { return (sourceCoordinate * numerator + denominator - 1) / denominator; }
    int source(int destinationCoordinate) const { return destinationCoordinate * denominator / numerator; }
};

inline Geometry fit(int sourceWidth, int sourceHeight, int previewSize) {
    Geometry geometry;
    if (sourceWidth <= 0 || sourceHeight <= 0 || previewSize <= 0)
        return geometry;

    geometry.sourceWidth = sourceWidth;
    geometry.sourceHeight = sourceHeight;
    geometry.numerator = previewSize;
    geometry.denominator = std::max(sourceWidth, sourceHeight);
    geometry.width = geometry.boundary(sourceWidth);
    geometry.height = geometry.boundary(sourceHeight);
    geometry.offsetX = (previewSize - geometry.width) / 2;
    geometry.offsetY = (previewSize - geometry.height) / 2;
    return geometry;
}

// JPEG blocks may contain padded columns. Keep their source stride while using
// the same scale for every block, the complete image, and the hold overlays.
inline void copyBlock(const Geometry& geometry, const uint16_t* sourcePixels, int sourceStride, int blockX, int blockY,
                      int blockWidth, int blockHeight, uint16_t* destinationPixels, int destinationStride,
                      int destinationX = 0, int destinationY = 0) {
    if (!sourcePixels || !destinationPixels || geometry.width <= 0 || geometry.height <= 0)
        return;

    int left = std::max(0, geometry.boundary(blockX));
    int top = std::max(0, geometry.boundary(blockY));
    int right = std::min(geometry.width, geometry.boundary(blockX + blockWidth));
    int bottom = std::min(geometry.height, geometry.boundary(blockY + blockHeight));
    for (int row = top; row < bottom; row++) {
        const uint16_t* sourceRow = sourcePixels + (geometry.source(row) - blockY) * sourceStride;
        uint16_t* destinationRow = destinationPixels + (destinationY + row) * destinationStride + destinationX;
        for (int column = left; column < right; column++) {
            destinationRow[column] = sourceRow[geometry.source(column) - blockX];
        }
    }
}

}  // namespace amoled_preview

#endif
