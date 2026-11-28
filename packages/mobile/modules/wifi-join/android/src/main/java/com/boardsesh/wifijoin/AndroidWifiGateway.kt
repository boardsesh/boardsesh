package com.boardsesh.wifijoin

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import androidx.annotation.RequiresApi

/**
 * Android 10+ (API 29): a WifiNetworkSpecifier request shows the system
 * "connect to device" prompt and gives this app alone a local-only network.
 * The phone's normal Wi-Fi or mobile data stays the default for other apps.
 */
@RequiresApi(Build.VERSION_CODES.Q)
class AndroidWifiGateway(private val connectivity: ConnectivityManager) : WifiNetworkGateway<Network> {
    override fun request(ssid: String, passphrase: String?, listener: WifiNetworkGateway.Listener<Network>): Any {
        val specifier = WifiNetworkSpecifier.Builder()
            .setSsid(ssid)
            .apply { if (!passphrase.isNullOrEmpty()) setWpa2Passphrase(passphrase) }
            .build()
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            // A device hotspot has no internet; without this the request never matches.
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(specifier)
            .build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = listener.onAvailable(network)
            override fun onUnavailable() = listener.onUnavailable()
            override fun onLost(network: Network) = listener.onLost(network)
        }
        connectivity.requestNetwork(request, callback)
        return callback
    }

    override fun unregister(registration: Any) {
        try {
            connectivity.unregisterNetworkCallback(registration as ConnectivityManager.NetworkCallback)
        } catch (alreadyGone: IllegalArgumentException) {
            // Already unregistered.
        }
    }

    override fun bind(network: Network?): Boolean = connectivity.bindProcessToNetwork(network)
}
