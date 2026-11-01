#pragma once

// Reproduce the selected SDK's unconditional INFO definition even when the
// command line supplied NONE. Undef first only to keep -Werror useful here.
#undef CONFIG_BT_NIMBLE_LOG_LEVEL
#define CONFIG_BT_NIMBLE_LOG_LEVEL 1
#define FIXTURE_TEST_SDK_INFO_WAS_INCLUDED 1
