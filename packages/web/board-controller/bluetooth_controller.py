# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Boardsesh contributors

"""
Bluetooth controller module that can be imported and integrated with the main server
This wraps the existing controller.py functionality
"""

import asyncio
import logging
import threading
from typing import Callable, Optional, List, Tuple

logger = logging.getLogger(__name__)


class BluetoothController:
    """
    Wrapper for the existing Bluetooth controller that allows integration
    with the queue management system
    """
    
    def __init__(self, queue_callback: Optional[Callable] = None):
        """
        Initialize Bluetooth controller
        
        Args:
            queue_callback: Callback function to handle LED updates
                           Called with (led_data, inferred_climb_uuid)
        """
        self.queue_callback = queue_callback
        self.controller_thread = None
        self.is_running = False
        self.led_controller = None
        self.message_buffer = None
        
    def start(self):
        """Start the Bluetooth controller in a background thread"""
        if self.is_running:
            logger.warning("Bluetooth controller already running")
            return
        
        try:
            # Import the existing controller components
            from controller import SimpleLedController, SimpleMessageBuffer
            
            # Initialize LED controller
            self.led_controller = SimpleLedController()
            
            # Create custom message buffer that calls our callback
            class CallbackMessageBuffer(SimpleMessageBuffer):
                def __init__(self, led_controller, callback):
                    super().__init__(led_controller)
                    self.callback = callback
                
                def _process_command(self, command: str, led_data: List[tuple]):
                    """Override to add callback on LED updates"""
                    # Call parent implementation
                    super()._process_command(command, led_data)
                    
                    # If we have a callback, try to infer climb from LED pattern
                    if self.callback:
                        inferred_climb = self._infer_climb_from_leds(led_data)
                        if inferred_climb or led_data:
                            # Run callback in a thread-safe way
                            try:
                                self.callback(led_data, inferred_climb)
                            except Exception as e:
                                logger.error(f"Error in queue callback: {e}")
                
                def _infer_climb_from_leds(self, led_data: List[tuple]) -> Optional[str]:
                    """
                    Try to infer climb UUID from LED pattern
                    This is a placeholder - actual implementation would need
                    to match LED patterns to known climbs
                    """
                    # TODO: Implement actual climb inference logic
                    # This would require:
                    # 1. Loading climb hold data from database
                    # 2. Matching LED positions to hold positions
                    # 3. Finding climb that matches the pattern
                    return None
            
            # Replace message buffer with our callback version
            self.message_buffer = CallbackMessageBuffer(self.led_controller, self.queue_callback)
            
            # Start Bluetooth service in thread
            self.controller_thread = threading.Thread(
                target=self._run_bluetooth_service,
                daemon=True
            )
            self.controller_thread.start()
            self.is_running = True
            
            logger.info("Bluetooth controller started successfully")
            
        except ImportError as e:
            logger.error(f"Failed to import controller components: {e}")
            logger.info("Make sure kilter_official_app.py and related files are present")
        except Exception as e:
            logger.error(f"Failed to start Bluetooth controller: {e}")
    
    def _run_bluetooth_service(self):
        """
        Run the Bluetooth service
        This is a simplified version - the actual implementation would
        integrate with the existing controller.py main loop
        """
        try:
            # Import required components
            import dbus
            import dbus.mainloop.glib
            from gi.repository import GLib
            from controller import (
                SimpleRxCharacteristic,
                Application,
                UartService,
                KilterAdvertisement,
                BLUEZ_SERVICE_NAME,
                GATT_MANAGER_IFACE,
                LE_ADVERTISING_MANAGER_IFACE,
                configure_adapter
            )
            
            # Set up D-Bus
            dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
            bus = dbus.SystemBus()
            
            adapter = '/org/bluez/hci0'
            configure_adapter(bus, adapter)
            
            # Get managers
            service_manager = dbus.Interface(
                bus.get_object(BLUEZ_SERVICE_NAME, adapter),
                GATT_MANAGER_IFACE
            )
            
            ad_manager = dbus.Interface(
                bus.get_object(BLUEZ_SERVICE_NAME, adapter),
                LE_ADVERTISING_MANAGER_IFACE
            )
            
            # Create application with our custom message buffer
            app = Application(bus)
            app.services.clear()
            
            # Create custom RX characteristic that uses our message buffer
            class CustomRxCharacteristic(SimpleRxCharacteristic):
                def __init__(self, bus, index, service, message_buffer, led_controller):
                    super().__init__(bus, index, service, led_controller)
                    self.message_buffer = message_buffer
            
            uart_service = UartService(bus, 0)
            uart_service.characteristics[0] = CustomRxCharacteristic(
                bus, 0, uart_service, self.message_buffer, self.led_controller
            )
            
            app.add_service(uart_service)
            
            # Create advertisement
            adv = KilterAdvertisement(bus, 0)
            
            # Create main loop
            mainloop = GLib.MainLoop()
            
            # Register callbacks
            def register_app_cb():
                logger.info('✅ GATT application registered')
                logger.info(f'💡 LED controller ready')
            
            def register_app_error_cb(error):
                logger.error('Failed to register application: ' + str(error))
                mainloop.quit()
            
            def register_ad_cb():
                logger.info('✅ Advertisement registered')
                logger.info('📱 Ready for Kilter/Tension Board app connections')
            
            def register_ad_error_cb(error):
                logger.error('Failed to register advertisement: ' + str(error))
            
            # Register everything
            logger.info('Starting Bluetooth service...')
            
            service_manager.RegisterApplication(
                app.get_path(), {},
                reply_handler=register_app_cb,
                error_handler=register_app_error_cb
            )
            
            ad_manager.RegisterAdvertisement(
                adv.get_path(), {},
                reply_handler=register_ad_cb,
                error_handler=register_ad_error_cb
            )
            
            # Run main loop
            mainloop.run()
            
        except Exception as e:
            logger.error(f"Bluetooth service error: {e}")
            self.is_running = False
    
    def stop(self):
        """Stop the Bluetooth controller"""
        if self.is_running:
            logger.info("Stopping Bluetooth controller...")
            self.is_running = False
            
            # Clear LEDs if controller exists
            if self.led_controller:
                try:
                    self.led_controller.clear()
                except:
                    pass
            
            # Note: Stopping the GLib main loop would require
            # additional implementation
    
    def set_leds(self, led_data: List[Tuple[int, int, int, int]]):
        """
        Manually set LEDs (for testing or external control)
        
        Args:
            led_data: List of (position, r, g, b) tuples
        """
        if self.led_controller:
            try:
                self.led_controller.update(led_data)
            except Exception as e:
                logger.error(f"Failed to set LEDs: {e}")
    
    def clear_leds(self):
        """Clear all LEDs"""
        if self.led_controller:
            try:
                self.led_controller.clear()
            except Exception as e:
                logger.error(f"Failed to clear LEDs: {e}")