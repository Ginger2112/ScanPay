package com.scantopay.observer

import android.content.Context
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Runs the one-time pairing exchange in an app-wide scope, so rotation, dark-mode switches or any
 * other activity recreation can't cancel it halfway (code burned on the server, token never saved).
 * The current activity attaches to hear the outcome; if none is attached it is kept until one does.
 */
object Pairing {

    class Outcome(val ok: Boolean, val merchant: String)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // All fields below are touched on the main thread only.
    var running = false
        private set
    private var pending: Outcome? = null
    private var listener: ((Outcome) -> Unit)? = null

    /** Starts the exchange unless one is already running. Main thread. */
    fun start(ctx: Context, server: String, code: String): Boolean {
        if (running) return false
        running = true
        val app = ctx.applicationContext
        scope.launch {
            val res = exchange(server, code)
            if (res != null) {
                Config.save(app, server, res.first)
                CreditReporter.ping(app)
            }
            withContext(Dispatchers.Main) {
                running = false
                val o = Outcome(res != null, res?.second ?: "")
                val l = listener
                if (l != null) l(o) else pending = o
            }
        }
        return true
    }

    fun attach(l: (Outcome) -> Unit) {
        listener = l
        pending?.let { pending = null; l(it) }
    }

    fun detach(l: (Outcome) -> Unit) {
        if (listener === l) listener = null
    }

    // Swaps the one-time code for this phone's own token. Returns (token, merchant name) or null.
    private fun exchange(server: String, code: String): Pair<String, String>? = try {
        val conn = (URL("$server/api/observer/pair").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; connectTimeout = 10000; readTimeout = 10000; doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        val device = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        conn.outputStream.use { it.write(JSONObject().put("code", code).put("device", device).toString().toByteArray()) }
        val ok = conn.responseCode == 200
        val body = (if (ok) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        conn.disconnect()
        if (!ok) null else JSONObject(body).let { it.getString("token") to it.optString("merchant_name", "your business") }
    } catch (_: Exception) { null }
}
