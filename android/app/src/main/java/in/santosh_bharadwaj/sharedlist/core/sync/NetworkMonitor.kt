package `in`.santosh_bharadwaj.sharedlist.core.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import androidx.core.content.getSystemService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Proactive online/offline awareness for the sync engine. Mirrors iOS
 * `NetworkMonitor` (which wraps `NWPathMonitor`).
 *
 * Why proactive: the sync drainer (slice C.3) needs to know whether to
 * even attempt a request. A reactive approach (just try, fail with a
 * transport error) burns power, generates spurious error logs, and
 * confuses the retry path. Android's [ConnectivityManager] solves this
 * via [NetworkRequest] + a [ConnectivityManager.NetworkCallback], which
 * delivers callbacks on every connectivity transition — Wi-Fi drop,
 * cellular handover, airplane mode toggle, VPN flap.
 *
 * Why [StateFlow] (vs Compose `State` directly):
 *   - The Drainer reads `isOnline` from a non-Composable context.
 *   - StateFlow has a `.value` accessor for the snapshot read AND a
 *     `collect { }` for change observation; Compose can subscribe via
 *     `collectAsState()` for free.
 *   - Mirrors iOS's `@Observable` pattern at a closer-than-RxJava abstraction.
 *
 * Lifecycle:
 *   We register the network callback in [start] and unregister in [stop].
 *   The AppContainer calls [start] on construction and never stops —
 *   the monitor is meant to live for the app's lifetime. We expose
 *   [stop] so tests can clean up between runs (Robolectric / instrumented
 *   tests).
 *
 * Threading:
 *   ConnectivityManager delivers callbacks on a system-managed thread.
 *   We update [_isOnline] from there directly — `MutableStateFlow` is
 *   thread-safe under concurrent `.update { }` / assignment.
 */
public interface NetworkMonitoring {
    public val isOnline: StateFlow<Boolean>
}

public class NetworkMonitor(context: Context) : NetworkMonitoring {
    private val connectivityManager: ConnectivityManager =
        context.applicationContext.getSystemService<ConnectivityManager>()
            ?: error("ConnectivityManager service unavailable")

    private val _isOnline = MutableStateFlow(false)
    override val isOnline: StateFlow<Boolean> = _isOnline.asStateFlow()

    /**
     * Track every active network the OS reports. Multi-network is real
     * on Android (Wi-Fi + cellular concurrently when one is metered);
     * we treat "any validated, internet-capable network" as online.
     * The set is intentionally NOT exposed — only the boolean derived
     * from its non-emptiness is, because the rest of the app doesn't
     * need to know the network type.
     */
    private val activeNetworks: MutableSet<Network> = mutableSetOf()

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            synchronized(activeNetworks) {
                activeNetworks += network
                _isOnline.value = activeNetworks.isNotEmpty()
            }
        }

        override fun onLost(network: Network) {
            synchronized(activeNetworks) {
                activeNetworks -= network
                _isOnline.value = activeNetworks.isNotEmpty()
            }
        }

        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            // A network can be "available" before it's "validated" (the
            // OS confirms internet reachability via a captive-portal
            // probe). We require validated to call ourselves online so
            // the drainer doesn't fire requests against a captive
            // portal. Wi-Fi networks where validation hasn't completed
            // yet hit this path BEFORE onAvailable resolves the
            // membership question.
            val validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            synchronized(activeNetworks) {
                if (validated) {
                    activeNetworks += network
                } else {
                    activeNetworks -= network
                }
                _isOnline.value = activeNetworks.isNotEmpty()
            }
        }
    }

    /**
     * Begin observing connectivity. Idempotent — calling twice is a
     * no-op (the OS would silently throw on duplicate registration).
     */
    public fun start() {
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            .build()
        connectivityManager.registerNetworkCallback(request, callback)
    }

    /** Stop observing. Tests use this between runs; production never calls it. */
    public fun stop() {
        try {
            connectivityManager.unregisterNetworkCallback(callback)
        } catch (_: IllegalArgumentException) {
            // Already unregistered, or never registered. Idempotent.
        }
    }
}

/**
 * Test double — the SyncEngine and Drainer both read [isOnline] only,
 * so a tiny class with a mutable StateFlow is enough to script
 * offline/online transitions in tests.
 */
public class FakeNetworkMonitor(initial: Boolean = true) : NetworkMonitoring {
    private val _isOnline = MutableStateFlow(initial)
    override val isOnline: StateFlow<Boolean> = _isOnline.asStateFlow()

    public fun setOnline(value: Boolean) {
        _isOnline.value = value
    }
}
