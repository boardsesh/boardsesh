#ifndef BOARD_CONFIG_KEY_H
#define BOARD_CONFIG_KEY_H

#include <Arduino.h>

// How many set ids the board controller will parse out of a render path.
//
// It matches MAX_SET_IDS in packages/shared/board-render/src/validation.ts and
// the copy in embedded/libs/thumbnail-client/src/thumbnail_client.cpp; the
// widest shipped config is Decoy layout 2 / size 1 at 19 sets. At the old 16
// this dropped the last three and built a config KEY out of what was left, so
// two different Decoy configs collapsed onto one cached board image.
// set-ids-catalogue.test.ts reads this declaration and fails if it drifts from
// the server's.
//
// It sits in a header rather than in main.cpp so the native test env can reach
// it — main.cpp carries the Arduino entry points and the display globals, and
// cannot be linked into a host binary. See embedded/test/test_board_config_key.
static const int BOARD_CONFIG_MAX_SET_IDS = 24;

/**
 * Extract config key from boardPath, stripping the angle segment.
 * "kilter/1/7/1,20/40" -> "kilter/1/7/1,20"
 * Also sorts set_ids numerically for consistent matching.
 */
inline String extractConfigKey(const char* boardPath) {
    if (!boardPath) return "";

    String bp = boardPath;
    // Find segments: board_name/layout_id/size_id/set_ids/angle
    int slash1 = bp.indexOf('/');
    if (slash1 < 0) return "";
    int slash2 = bp.indexOf('/', slash1 + 1);
    if (slash2 < 0) return "";
    int slash3 = bp.indexOf('/', slash2 + 1);
    if (slash3 < 0) return "";
    int slash4 = bp.indexOf('/', slash3 + 1);

    // Extract set_ids part and sort numerically
    String setIdsPart;
    if (slash4 > 0) {
        setIdsPart = bp.substring(slash3 + 1, slash4);
    } else {
        setIdsPart = bp.substring(slash3 + 1);
    }

    int setIds[BOARD_CONFIG_MAX_SET_IDS];
    int setCount = 0;
    int start = 0;
    bool tooManySetIds = false;
    for (int i = 0; i <= (int)setIdsPart.length(); i++) {
        if (i == (int)setIdsPart.length() || setIdsPart[i] == ',') {
            if (i > start) {
                if (setCount >= BOARD_CONFIG_MAX_SET_IDS) {
                    tooManySetIds = true;
                    break;
                }
                setIds[setCount++] = setIdsPart.substring(start, i).toInt();
            }
            start = i + 1;
        }
    }
    if (setCount == 0) return "";
    // Past the cap, key on the list exactly as it arrived. Sorting only makes
    // two spellings of one config agree; a TRUNCATED key makes two different
    // configs agree, which is worse than an unsorted one.
    //
    // `sortSetIds` in embedded/libs/thumbnail-client takes the same way out for
    // the same reason, and the two are worth reading together: neither firmware
    // component can shorten the list, because the server canonicalises set ids
    // itself and so still renders the right board from an unsorted one — but
    // nothing downstream can recover a set id that was dropped here.
    if (tooManySetIds) return bp.substring(0, slash3 + 1) + setIdsPart;

    // Simple insertion sort
    for (int i = 1; i < setCount; i++) {
        int key = setIds[i];
        int j = i - 1;
        while (j >= 0 && setIds[j] > key) {
            setIds[j + 1] = setIds[j];
            j--;
        }
        setIds[j + 1] = key;
    }

    // Rebuild sorted set_ids string
    String sortedSetIds;
    for (int i = 0; i < setCount; i++) {
        if (i > 0) sortedSetIds += ",";
        sortedSetIds += String(setIds[i]);
    }

    // Build config key: board_name/layout_id/size_id/sorted_set_ids
    return bp.substring(0, slash3 + 1) + sortedSetIds;
}

#endif  // BOARD_CONFIG_KEY_H
