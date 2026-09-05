// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef FIRMWARE_VERSION_H
#define FIRMWARE_VERSION_H

// CI overrides these via -D build flags
// Local builds use these defaults
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "dev"
#endif

#ifndef FIRMWARE_BUILD_ENV
#define FIRMWARE_BUILD_ENV "unknown"
#endif

#endif
