package `in`.santosh_bharadwaj.sharedlist.core.storage

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Tests for the in-memory implementation. The real
 * EncryptedSharedPreferencesStorage requires an Android Context (Keystore +
 * SharedPreferences) so it lives behind an instrumented-test boundary;
 * Phase 6 ships pure-JVM unit tests only (PLAN.md L308).
 *
 * Mirrors iOS `InMemoryKeychainStoreTests`.
 */
class InMemorySecureStorageTest {
    @Test
    fun roundTripsAValue() = runTest {
        val store = InMemorySecureStorage()
        store.set("k", "v")
        assertEquals("v", store.get("k"))
    }

    @Test
    fun overwritesExistingValue() = runTest {
        val store = InMemorySecureStorage()
        store.set("k", "first")
        store.set("k", "second")
        assertEquals("second", store.get("k"))
    }

    @Test
    fun returnsNullForMissingKey() = runTest {
        val store = InMemorySecureStorage()
        assertNull(store.get("never-set"))
    }

    @Test
    fun deleteRemovesValue() = runTest {
        val store = InMemorySecureStorage()
        store.set("k", "v")
        store.delete("k")
        assertNull(store.get("k"))
    }

    @Test
    fun deleteIsIdempotent() = runTest {
        val store = InMemorySecureStorage()
        // Deleting a missing key must not throw — public contract mirrors iOS.
        store.delete("never-set")
        store.set("k", "v")
        store.delete("k")
        store.delete("k")
        assertNull(store.get("k"))
    }
}
