package `in`.santosh_bharadwaj.sharedlist.core.auth

import `in`.santosh_bharadwaj.sharedlist.core.storage.InMemorySecureStorage
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

/**
 * Mirrors iOS `TokenStoreTests`. Same five scenarios:
 *   1. Empty storage → no tokens.
 *   2. save() exposes current AND survives rehydration in a fresh store.
 *   3. updateTokens() rotates without disturbing the user record.
 *   4. updateTokens() throws if not logged in.
 *   5. clear() purges in-memory + persisted state.
 */
class TokenStoreTest {
    private val sampleUser = AuthUser(id = "u1", email = "alice@example.com", displayName = "Alice")

    @Test
    fun loadsNothingFromEmptyStorage() = runTest {
        val store = TokenStore(InMemorySecureStorage())
        store.loadFromStorage()
        assertNull(store.current)
    }

    @Test
    fun saveExposesCurrentAndPersists() = runTest {
        val storage = InMemorySecureStorage()
        val store = TokenStore(storage)
        store.save(TokenStore.Tokens(accessToken = "a", refreshToken = "r", user = sampleUser))

        // In-memory state.
        assertEquals("a", store.current?.accessToken)
        assertEquals("r", store.current?.refreshToken)
        assertEquals(sampleUser, store.current?.user)

        // Persisted state — a fresh store reading the same storage must come
        // back with the same values. This is what proves "refresh token
        // survives app restart" at the unit-test level. The real-device
        // verification happens in Phase 6's manual end-to-end test.
        val rehydrated = TokenStore(storage)
        rehydrated.loadFromStorage()
        assertEquals("a", rehydrated.current?.accessToken)
        assertEquals("r", rehydrated.current?.refreshToken)
        assertEquals(sampleUser, rehydrated.current?.user)
    }

    @Test
    fun updateTokensRotatesPair() = runTest {
        val storage = InMemorySecureStorage()
        val store = TokenStore(storage)
        store.save(TokenStore.Tokens(accessToken = "a1", refreshToken = "r1", user = sampleUser))

        store.updateTokens(accessToken = "a2", refreshToken = "r2")

        assertEquals("a2", store.current?.accessToken)
        assertEquals("r2", store.current?.refreshToken)
        assertEquals(sampleUser, store.current?.user)
    }

    @Test
    fun updateTokensThrowsIfNotLoggedIn() = runTest {
        val store = TokenStore(InMemorySecureStorage())
        try {
            store.updateTokens(accessToken = "a", refreshToken = "r")
            fail("expected TokenStoreException.NotLoggedIn")
        } catch (e: TokenStoreException.NotLoggedIn) {
            // expected
            assertNotNull(e.message)
        }
    }

    @Test
    fun clearRemovesEverything() = runTest {
        val storage = InMemorySecureStorage()
        val store = TokenStore(storage)
        store.save(TokenStore.Tokens(accessToken = "a", refreshToken = "r", user = sampleUser))

        store.clear()
        assertNull(store.current)

        val rehydrated = TokenStore(storage)
        rehydrated.loadFromStorage()
        assertNull(rehydrated.current)
    }
}
