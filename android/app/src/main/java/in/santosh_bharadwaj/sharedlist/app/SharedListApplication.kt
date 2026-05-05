package `in`.santosh_bharadwaj.sharedlist.app

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Application class — owns the long-lived `AppContainer` for the process.
 *
 * Why a custom Application subclass instead of constructing the container in
 * `MainActivity.onCreate`?
 *   - The Application object's lifecycle matches the OS process. The container
 *     and everything it owns (TokenStore, ApiClient, the CoroutineScope) live
 *     for as long as the process does. An Activity can be recreated on
 *     configuration change; we don't want to re-hydrate the keystore on every
 *     orientation flip.
 *   - It gives us a single, well-known place for cross-screen singletons,
 *     mirroring iOS where `SharedListApp` constructs `AppContainer` once.
 *
 * The `applicationScope` is the long-lived coroutine scope that survives
 * process death only. Anything launched in here outlives any screen. We use a
 * `SupervisorJob` so a failure in one launched coroutine doesn't cancel the
 * scope itself — a single sync-engine retry that errors shouldn't take down
 * the whole app.
 */
public class SharedListApplication : Application() {
    public val applicationScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    public lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer.create(this)

        // Hydrate any persisted session in the background. Mirrors iOS's
        // bootstrap() call from SharedListApp.task — happens off the main
        // thread because the encrypted SharedPreferences read does I/O and
        // KeyStore unwrap, which can take double-digit milliseconds on first
        // launch after boot.
        applicationScope.launch {
            container.bootstrap()
        }
    }
}
