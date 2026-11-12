#ifndef POWER_LIMIT_H
#define POWER_LIMIT_H

#include <stddef.h>
#include <stdint.h>

/**
 * A configured current cap for the LED string (Spraywall build).
 *
 * The controller cannot measure its supply, so the draw is estimated from what
 * is about to be shown: each pixel draws `perPixelMilliamps` at full white
 * (255, 255, 255) and proportionally less for dimmer colours, all scaled by the
 * master brightness. Quiescent current (about 1 mA per pixel) is ignored, which
 * is why the per-pixel default is the worst case (60 mA, 5 V WS2812B).
 *
 * Pure on purpose: no FastLED, no Arduino, so the native tests check it.
 */
namespace PowerLimit {

/** Sum of r + g + b over a buffer of RGB triples (CRGB's memory layout). */
inline uint64_t channelSum(const uint8_t* rgb, size_t pixelCount) {
    uint64_t sum = 0;
    for (size_t i = 0; i < pixelCount * 3; i++)
        sum += rgb[i];
    return sum;
}

/** Estimated draw in mA of a frame whose channels sum to `channels`, at `brightness`. */
inline uint32_t estimateMilliamps(uint64_t channels, uint16_t perPixelMilliamps, uint8_t brightness) {
    // channels / 765 pixels at full white, each perPixelMilliamps, times brightness / 255.
    return (uint32_t)((channels * perPixelMilliamps * brightness) / (765ULL * 255ULL));
}

/**
 * The brightness to show the frame at: `brightness` when its estimate fits in
 * `maxMilliamps`, otherwise the highest brightness that does. 0 for the cap
 * means no cap (the Kilter builds).
 */
inline uint8_t limitBrightness(uint64_t channels, uint16_t perPixelMilliamps, uint8_t brightness,
                               uint32_t maxMilliamps) {
    if (maxMilliamps == 0 || perPixelMilliamps == 0 || channels == 0)
        return brightness;
    if (estimateMilliamps(channels, perPixelMilliamps, brightness) <= maxMilliamps)
        return brightness;
    // Largest b with channels * perPixel * b <= max * 765 * 255.
    uint64_t fits = ((uint64_t)maxMilliamps * 765ULL * 255ULL) / (channels * perPixelMilliamps);
    return fits >= brightness ? brightness : (uint8_t)fits;
}

}  // namespace PowerLimit

#endif
