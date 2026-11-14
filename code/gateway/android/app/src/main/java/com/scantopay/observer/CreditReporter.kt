package com.scantopay.observer

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Forwards bank SMS / bank-app notifications to ScanPay as raw text. The server
 * parses and matches them, so bank-format fixes never need a new app build.
 * Shows a "Payment received" notification when the server confirms an order.
 * Failed sends (no network / server down) wait in a small on-phone queue.
 */
object CreditReporter {

    private const val CH_ID = "scantopay_payments"
    private var notifId = 1000

    // Only messages with a money amount leave the phone — personal SMS are never sent.
    private const val AMT = """(?:₹|Rs\.?|INR)\s*[0-9]"""
    private const val KW = """credited|debited|received|paid you|has a credit|you got"""
    private val MONEY = Regex("""(?:$KW).{0,120}$AMT|$AMT.{0,120}(?:$KW)""",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))

    /** Forward a message if it looks like money. onDone runs once it is sent, queued or skipped. */
    fun handle(ctx: Context, sender: String, body: String, source: String, onDone: () -> Unit = {}) {
        // The server parses every bank + UPI app; here we only make sure personal chats never leave the phone.
        if (!MONEY.containsMatchIn(body) || !Config.isConfigured(ctx)) { onDone(); return }
        val app = ctx.applicationContext
        CoroutineScope(Dispatchers.IO).launch {
            val code = try { deliver(app, body, sender, source) } finally { onDone() }
            if (code == 200) flush(app)
        }
    }

    // Sends one message; queues it on network/server failure. Returns the HTTP code (-1 = no network).
    private fun deliver(ctx: Context, text: String, sender: String, source: String): Int {
        val r = send(ctx, text, sender, source)
        when {
            r.code == 200 -> confirmed(ctx, r)
            r.code == 401 -> if (!unlinked(ctx, r.token)) Queue.add(ctx, text, sender, source) // stale token: retry with the new one
            r.code == -1 || r.code >= 500 -> Queue.add(ctx, text, sender, source)
            // other 4xx: server rejected it, nothing to retry
        }
        return r.code
    }

    // token = the exact token this request carried, so a 401 only unlinks that token.
    private class Sent(val code: Int, val token: String = "", val matched: Boolean = false, val orderId: String? = null, val amount: String? = null)

    private fun send(ctx: Context, text: String, sender: String, source: String): Sent {
        val base = Config.baseUrl(ctx)
        val token = Config.token(ctx) // read once per request
        if (base.isBlank()) return Sent(0)
        return try {
            val conn = (URL("$base/api/observer/sms").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 5000; readTimeout = 5000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("x-observer-token", token)
            }
            val payload = JSONObject()
                .put("text", text)
                .put("sender", sender)
                .put("source", "android-$source")
            conn.outputStream.use { it.write(payload.toString().toByteArray()) }
            val code = conn.responseCode
            val resp = (if (code < 400) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            conn.disconnect()
            val j = runCatching { JSONObject(resp) }.getOrNull()
            val orderId = j?.optString("order_id")?.ifBlank { null }
            Sent(code, token, code == 200 && j?.optBoolean("matched") == true, orderId,
                j?.optJSONObject("parsed")?.optString("amount"))
        } catch (_: Exception) {
            Sent(-1, token)
        }
    }

    private fun confirmed(ctx: Context, r: Sent) {
        if (r.matched) notify(ctx, "Payment received",
            "₹${r.amount} confirmed" + (r.orderId?.let { " · $it" } ?: ""))
    }

    private val flushing = AtomicBoolean(false)

    /** Re-sends queued messages. Called on each heartbeat and after each successful post. Blocking. */
    fun flush(ctx: Context) {
        if (!Config.isConfigured(ctx) || !flushing.compareAndSet(false, true)) return
        try {
            for (item in Queue.all(ctx)) {
                val r = send(ctx, item.optString("text"), item.optString("sender"), item.optString("source"))
                when {
                    // Stale-token 401 (re-paired meanwhile): keep the queue, the next flush uses the new token.
                    r.code == 401 -> { if (unlinked(ctx, r.token)) Queue.clear(ctx); return }
                    r.code <= 0 || r.code >= 500 -> return // still down, try next time
                    else -> { if (r.code == 200) confirmed(ctx, r); Queue.remove(ctx, item) }
                }
            }
        } finally {
            flushing.set(false)
        }
    }

    /** Heartbeat: tells the server this phone is alive and what it can see. Returns the HTTP code (-1 = no network). Blocking. */
    fun ping(ctx: Context): Int {
        val base = Config.baseUrl(ctx)
        val token = Config.token(ctx) // read once per request
        if (base.isBlank() || token.isBlank()) return 0
        val code = try {
            val c = (URL("$base/api/observer/ping").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"; connectTimeout = 10000; readTimeout = 10000; doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("x-observer-token", token)
            }
            val sms = ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECEIVE_SMS) ==
                PackageManager.PERMISSION_GRANTED
            val body = JSONObject()
                .put("sms_permission", sms)
                .put("notification_access", NotificationService.isEnabled(ctx))
            c.outputStream.use { it.write(body.toString().toByteArray()) }
            val rc = c.responseCode
            c.disconnect()
            rc
        } catch (_: Exception) { -1 }
        if (code == 401) unlinked(ctx, token)
        return code
    }

    /**
     * Server says this phone was revoked: forget the token, stop watching, tell the merchant.
     * Only acts if usedToken is still the stored token (atomic check in Config). Returns true when it unlinked.
     */
    private fun unlinked(ctx: Context, usedToken: String): Boolean {
        if (!Config.markUnlinkedIf(ctx, usedToken)) return false
        runCatching { ctx.stopService(Intent(ctx, ObserverService::class.java)) }
        notify(ctx, "Phone unlinked", UNLINKED_MSG)
        return true
    }

    const val UNLINKED_MSG = "This phone was unlinked from ScanPay. Scan a new pairing QR to connect again."

    private fun notify(ctx: Context, title: String, text: String) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CH_ID, "Payments", NotificationManager.IMPORTANCE_HIGH)
        )
        val n = NotificationCompat.Builder(ctx, CH_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(title).setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true).build()
        runCatching { nm.notify(notifId++, n) }
    }

    /** Small persistent retry queue: SharedPreferences JSON array, max 200 items, nothing older than 24h. */
    private object Queue {
        private const val PREFS = "scantopay_queue"
        private const val K = "items"
        private const val MAX = 200
        private const val TTL = 24 * 60 * 60 * 1000L

        @Synchronized fun add(ctx: Context, text: String, sender: String, source: String) {
            val items = load(ctx)
            items.add(JSONObject().put("text", text).put("sender", sender)
                .put("source", source).put("at", System.currentTimeMillis()))
            store(ctx, items.takeLast(MAX))
        }

        @Synchronized fun all(ctx: Context): List<JSONObject> = load(ctx).also { store(ctx, it) }

        @Synchronized fun remove(ctx: Context, item: JSONObject) {
            store(ctx, load(ctx).filterNot {
                it.optLong("at") == item.optLong("at") && it.optString("text") == item.optString("text")
            })
        }

        @Synchronized fun clear(ctx: Context) = store(ctx, emptyList())

        // Reads the queue, dropping anything older than 24h.
        private fun load(ctx: Context): MutableList<JSONObject> {
            val raw = prefs(ctx).getString(K, "[]") ?: "[]"
            val arr = runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
            val cutoff = System.currentTimeMillis() - TTL
            return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
                .filter { it.optLong("at") >= cutoff }.toMutableList()
        }

        private fun store(ctx: Context, items: List<JSONObject>) {
            val arr = JSONArray(); items.forEach { arr.put(it) }
            prefs(ctx).edit().putString(K, arr.toString()).commit()
        }

        private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }
}
