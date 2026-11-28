# Device location permissions

Nearby board and gym searches accept Android Approximate location and iOS
Precise Location switched off. A granted foreground permission is sufficient;
the apps never request Always/background location access or a precise-location
upgrade. Device location comes from one-shot foreground requests. Gym name
search and map placement remain available when access is denied.

The native configuration disables the location plugin's Always and temporary
full-accuracy prompts, and blocks Android background-location and location
foreground-service permissions. Background board connections use the separate
Bluetooth connected-device service. Android 12+ Bluetooth discovery needs only
Nearby devices access; Android 11 and earlier still require fine location for
Bluetooth scanning because of the operating system's BLE permission rules.
