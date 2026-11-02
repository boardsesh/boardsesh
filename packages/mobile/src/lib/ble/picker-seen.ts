/**
 * What the device picker showed the climber in a session, reported by the
 * sheet through its one callback (`onSeen`) for the 2.7 release-watch props
 * on BLE Picker Devices Resolved:
 *
 * - `target_not_listed`: boards were found, none of them the gym or saved board
 *   the picker was opened for ("Search for any board" is the way on).
 * - `tips`: the troubleshooting tips (hardware, location permission, Location
 *   services) were on screen.
 */
export type DevicePickerSeen = 'target_not_listed' | 'tips';
