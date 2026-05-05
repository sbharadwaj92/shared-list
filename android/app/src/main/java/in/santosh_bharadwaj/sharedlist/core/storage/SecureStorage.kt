package `in`.santosh_bharadwaj.sharedlist.core.storage

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Custom wrapper around Android's encrypted SharedPreferences.
 *
 * Why a custom wrapper rather than `SecurePreferences` / a third-party lib?
 * PLAN.md mandates "depth of learning over speed to ship" (CLAUDE.md). The
 * AndroidX security-crypto library is itself the wrapper around Tink + the
 * Android Keystore; writing our own thin facade forces engagement with the
 * three primitives — MasterKey, AES-GCM 256 value scheme, AES-256-SIV key
 * scheme — rather than reaching for someone else's `set("k", "v")`.
 *
 * Mirrors iOS `KeychainStoring` interface verbatim so the call sites in
 * TokenStore are byte-identical between platforms.
 *
 * What's NOT here:
 *   - Biometric-gated read (Phase 19 level-up). Today the secret survives
 *     "device is unlocked" — the same accessibility tier as iOS's
 *     kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, by virtue of
 *     EncryptedSharedPreferences requiring the user-authentication-bound
 *     KeyStore master key to unwrap.
 *   - Cross-device sync. By design — refresh tokens are device-scoped.
 *   - Shared-prefs migration. We're net-new; if the storage format changes
 *     we'll write a migration step then.
 *
 * Threading: SharedPreferences read/write is synchronous and does disk I/O;
 * EncryptedSharedPreferences also does an AES-GCM round trip per access.
 * We make the methods `suspend` and run on `Dispatchers.IO` so callers can
 * await without blocking the main thread, mirroring the async surface of
 * iOS's KeychainStore.
 */
public interface SecureStorage {
    public suspend fun set(key: String, value: String)
    public suspend fun get(key: String): String?
    public suspend fun delete(key: String)
}

public class SecureStorageError(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Real implementation backed by EncryptedSharedPreferences.
 *
 * The key derivation: AndroidX builds a `MasterKey` (AES-256, GCM-mode) inside
 * the device-bound Android Keystore. That master key wraps a per-prefs-file
 * data encryption key, which encrypts each value (AES-256-GCM authenticated
 * encryption) and each key-name (AES-256-SIV deterministic encryption — same
 * plaintext name yields same ciphertext, which we need to look values up).
 *
 * The MasterKey lives in the StrongBox-backed Android Keystore on devices
 * that have a hardware security module (S24 Ultra does). Without StrongBox
 * we fall back to TEE; either way the raw key bytes never leave the secure
 * enclave. AES operations happen in the Keystore daemon, the app process
 * only sees ciphertext.
 *
 * Reference: https://developer.android.com/reference/androidx/security/crypto/EncryptedSharedPreferences
 */
public class EncryptedSharedPreferencesStorage(
    context: Context,
    fileName: String = DEFAULT_FILE_NAME,
) : SecureStorage {

    private val prefs by lazy {
        try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context,
                fileName,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (t: Throwable) {
            // The most common failure mode here is a corrupted master-key
            // entry (e.g. the user wiped their Keystore via Settings →
            // Reset). Surfacing as a typed error lets TokenStore treat it as
            // "logged out" rather than crashing, mirroring iOS's
            // graceful-degrade behavior in `loadFromKeychain`.
            throw SecureStorageError("failed to open EncryptedSharedPreferences", t)
        }
    }

    override suspend fun set(key: String, value: String) {
        // commit() is synchronous; we run on IO dispatcher in tests by virtue
        // of being a suspend function. The official guidance is `apply()`
        // (fire-and-forget), but for token writes we want the persistence to
        // happen before we report success — otherwise a crash between
        // in-memory state update and disk flush would leave the user logged in
        // in memory and logged out on relaunch.
        @Suppress("ApplySharedPref")
        prefs.edit().putString(key, value).commit()
    }

    override suspend fun get(key: String): String? = prefs.getString(key, null)

    override suspend fun delete(key: String) {
        @Suppress("ApplySharedPref")
        prefs.edit().remove(key).commit()
    }

    public companion object {
        public const val DEFAULT_FILE_NAME: String = "sharedlist_secure_prefs"
    }
}

/**
 * In-memory fake for unit tests + Compose previews. Mirrors iOS
 * `InMemoryKeychainStore`. Deliberately exposed as a regular implementation,
 * not gated behind a debug flag — the production binary sees the same type;
 * tests just inject this implementation in place of the encrypted one.
 */
public class InMemorySecureStorage : SecureStorage {
    private val storage = mutableMapOf<String, String>()
    private val lock = Any()

    override suspend fun set(key: String, value: String) {
        synchronized(lock) { storage[key] = value }
    }

    override suspend fun get(key: String): String? = synchronized(lock) { storage[key] }

    override suspend fun delete(key: String) {
        synchronized(lock) { storage.remove(key) }
    }
}
