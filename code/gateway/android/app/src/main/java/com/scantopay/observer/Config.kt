package com.scantopay.observer

import android.content.Context

/** Server URL + this phone's observer token, stored on-device. */
object Config {
    private const val PREFS = "scantopay"
    private const val K_BASE = "base_url"
    private const val K_TOKEN = "token"
    private const val K_UNLINKED = "unlinked"
    private const val K_LAST_CODE = "last_pair_code"

    fun baseUrl(ctx: Context): String =
        prefs(ctx).getString(K_BASE, "") ?: ""

    fun token(ctx: Context): String =
        prefs(ctx).getString(K_TOKEN, "") ?: ""

    @Synchronized
    fun save(ctx: Context, baseUrl: String, token: String) {
        prefs(ctx).edit()
            .putString(K_BASE, baseUrl.trim().trimEnd('/'))
            .putString(K_TOKEN, token.trim())
            .putBoolean(K_UNLINKED, false)
            .apply() // in-memory prefs update immediately, so markUnlinkedIf sees the new token
    }

    fun isConfigured(ctx: Context): Boolean =
        baseUrl(ctx).isNotBlank() && token(ctx).isNotBlank()

    /**
     * Server revoked this phone (401): drop the token, keep the server URL.
     * Only when the stored token is still the one that got the 401, so a late reply for an
     * old token can never wipe a freshly paired one. Returns true when it unlinked.
     */
    @Synchronized
    fun markUnlinkedIf(ctx: Context, usedToken: String): Boolean {
        if (usedToken.isBlank() || token(ctx) != usedToken) return false
        prefs(ctx).edit().putString(K_TOKEN, "").putBoolean(K_UNLINKED, true).commit()
        return true
    }

    // One-time pairing codes already used on this phone, so a replayed link is ignored.
    fun lastPairCode(ctx: Context): String = prefs(ctx).getString(K_LAST_CODE, "") ?: ""

    fun setLastPairCode(ctx: Context, code: String) {
        prefs(ctx).edit().putString(K_LAST_CODE, code).commit()
    }

    fun wasUnlinked(ctx: Context): Boolean = prefs(ctx).getBoolean(K_UNLINKED, false)

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
