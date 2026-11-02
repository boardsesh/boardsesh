#include <sdkconfig.h>
#include <cstdio>

#ifndef CORE_DEBUG_LEVEL
#error "Gym build must define Arduino logging explicitly"
#endif
#ifndef CONFIG_NIMBLE_CPP_LOG_LEVEL
#error "Gym build must define NimBLE C++ logging explicitly"
#endif
static_assert(FIXTURE_TEST_SDK_INFO_WAS_INCLUDED == 1, "Exercise SDK INFO override");
static_assert(CONFIG_BT_NIMBLE_LOG_LEVEL == 5, "Gym header must override SDK host INFO after including sdkconfig");
static_assert(CORE_DEBUG_LEVEL == 0, "Inherited Arduino INFO must be removed from gym flags");
static_assert(CONFIG_NIMBLE_CPP_LOG_LEVEL == 0, "Gym NimBLE C++ logs must be disabled");

int main() {
    std::puts("QA logging: actual gym flags suppress Arduino/C++ and override SDK host INFO");
    return 0;
}
