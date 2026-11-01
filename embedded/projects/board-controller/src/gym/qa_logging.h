#pragma once

// Force-included only in gym fixture builds, before NimBLE or Arduino headers.
// NimBLE 2.5.2 defaults to NONE only if sdkconfig has not already set a level.
// Arduino's selected ESP32-S3 SDK defines INFO unconditionally, so a command-line
// -D is overwritten. Include it first and override the host level afterwards.
#include <sdkconfig.h>
#undef CONFIG_BT_NIMBLE_LOG_LEVEL
#define CONFIG_BT_NIMBLE_LOG_LEVEL 5
