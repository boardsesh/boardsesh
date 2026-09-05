// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Preferences Mock Implementation
 */

#include "Preferences.h"

// Static storage definition
std::map<std::string, std::map<std::string, std::vector<uint8_t>>> Preferences::storage_;
