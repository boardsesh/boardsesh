// UNBUILT AND UNTESTED: see README.md.
//
// Registration for WLED builds that use `custom_usermods` (WLED after 0.15,
// where usermods are PlatformIO libraries that register themselves). On WLED
// 0.15.x this file is not used: register the class in wled00/usermods_list.cpp
// instead (README, "WLED 0.15.x").
#include "usermod_boardsesh_ble.h"

#ifdef REGISTER_USERMOD
static BoardseshBleUsermod boardsesh_ble;
REGISTER_USERMOD(boardsesh_ble);
#endif
