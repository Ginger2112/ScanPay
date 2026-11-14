package com.scantopay.observer

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.scantopay.observer.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URLEncoder

class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private var askedPush = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.web.settings.apply { javaScriptEnabled = true; domStorageEnabled = true }
        b.web.webViewClient = android.webkit.WebViewClient()

        b.baseUrl.setText(Config.baseUrl(this))
        b.token.setText(Config.token(this))

        // Manual setup stays as a fallback (and for Arun's own shared-token phone).
        b.connect.setOnClickListener {
            Config.save(this, b.baseUrl.text.toString(), b.token.text.toString())
            if (!Config.isConfigured(this)) {
                b.status.text = "Enter the server URL and token, or scan a pairing QR."
                return@setOnClickListener
            }
            goLive()
        }
        b.pushAccess.setOnClickListener { openPushSettings() }

        // Only a fresh launch handles the pair link; a recreated activity or a Recents relaunch
        // (Android 8-11 re-delivers the original intent) must not replay a used code.
        val pairing = savedInstanceState == null && !fromHistory(intent) && handlePairLink(intent)
        if (!pairing) startNormal()
        if (Pairing.running) b.status.text = "Connecting…"
    }

    override fun onStart() {
        super.onStart()
        Pairing.attach(onPaired)
    }

    override fun onStop() {
        Pairing.detach(onPaired)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (!fromHistory(intent)) handlePairLink(intent)
    }

    private fun fromHistory(i: Intent?): Boolean =
        i != null && (i.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0

    override fun onResume() {
        super.onResume()
        if (Config.isConfigured(this)) {
            // Keeps "Phone connected" and the permission flags fresh on the merchant page.
            lifecycleScope.launch {
                withContext(Dispatchers.IO) { CreditReporter.ping(applicationContext) }
                if (!Config.isConfigured(this@MainActivity)) showSetup()
            }
        } else if (b.web.visibility == View.VISIBLE) {
            showSetup() // unlinked while we were in the background
        }
    }

    // Normal start: paired → dashboard, otherwise the setup panel.
    private fun startNormal() {
        if (Config.isConfigured(this)) {
            ObserverService.start(this)
            showDashboard()
            askPushAccess()
        } else {
            showSetup()
        }
    }

    /**
     * 1-click pairing: the pairing page opens scanoye://pair?server=…&code=…
     * We confirm with the user, swap the one-time code for this phone's own token and go live.
     * Returns true when the intent was a valid pair link (it is then handled here).
     */
    private fun handlePairLink(i: Intent?): Boolean {
        val data: Uri = i?.data ?: return false
        if (data.scheme != "scanoye" || data.host != "pair") return false
        // Consume the link so rotation / process recreation never re-runs it.
        setIntent(Intent(this, MainActivity::class.java))
        val server = data.getQueryParameter("server")?.trim()?.trimEnd('/')
        val code = data.getQueryParameter("code")
        val host = server?.let { Uri.parse(it).host }
        if (server == null || code.isNullOrBlank() || host.isNullOrBlank() || !isAllowedServer(server)) {
            Toast.makeText(this, "This pairing link isn't valid. Use the QR from your ScanPay page.", Toast.LENGTH_LONG).show()
            return false
        }
        // Same one-time code again (replayed link): it's already been used here, ignore it.
        if (code == Config.lastPairCode(this)) return false
        if (Pairing.running) {
            Toast.makeText(this, "Already connecting this phone. Please wait.", Toast.LENGTH_SHORT).show()
            return false
        }
        val replacing = Config.isConfigured(this)
        val msg = if (replacing)
            "This will replace this phone's current connection (${Uri.parse(Config.baseUrl(this)).host ?: "current server"})."
        else "This phone will forward bank and UPI credit alerts to that server."
        if (isFinishing || isDestroyed) return true
        AlertDialog.Builder(this)
            .setTitle("Connect this phone to ScanPay at $host?")
            .setMessage(msg)
            .setCancelable(false)
            .setPositiveButton("Connect") { _, _ -> pairNow(server, code) }
            .setNegativeButton("Cancel") { _, _ -> startNormal() }
            .show()
        return true
    }

    // https always; plain http only for localhost or a literal private / LAN IPv4 address (local testing).
    private fun isAllowedServer(server: String): Boolean {
        val u = Uri.parse(server)
        val host = u.host?.lowercase() ?: return false
        return when (u.scheme?.lowercase()) {
            "https" -> true
            "http" -> host == "localhost" || isPrivateIpv4(host)
            else -> false
        }
    }

    // Literal dotted IPv4 only (so "10.evil.com" fails) inside 127/8, 10/8, 192.168/16 or 172.16-31.
    private fun isPrivateIpv4(host: String): Boolean {
        if (!Regex("""^(\d{1,3})(\.\d{1,3}){3}$""").matches(host)) return false
        val o = host.split('.').map { it.toInt() }
        if (o.any { it > 255 }) return false
        return o[0] == 127 || o[0] == 10 ||
            (o[0] == 192 && o[1] == 168) ||
            (o[0] == 172 && o[1] in 16..31)
    }

    // The exchange runs in Pairing's app-wide scope, so recreating this screen can't cancel it.
    private fun pairNow(server: String, code: String) {
        Config.setLastPairCode(this, code) // one-time code: never replay it
        b.status.text = "Connecting…"
        if (!Pairing.start(this, server, code))
            Toast.makeText(this, "Already connecting this phone. Please wait.", Toast.LENGTH_SHORT).show()
    }

    private val onPaired: (Pairing.Outcome) -> Unit = { o ->
        if (!o.ok) {
            b.status.text = "That QR is used or expired. Show a fresh QR and scan it again."
            showSetup(keepStatus = true)
        } else {
            b.baseUrl.setText(Config.baseUrl(this)); b.token.setText(Config.token(this))
            b.status.text = ""
            Toast.makeText(this, "Connected to ${o.merchant}", Toast.LENGTH_LONG).show()
            goLive()
            askPushAccess()
        }
    }

    private fun goLive() {
        requestPerms()
        ObserverService.start(this)
        showDashboard()
    }

    private fun showDashboard() {
        b.setup.visibility = View.GONE
        b.web.visibility = View.VISIBLE
        val base = Config.baseUrl(this)
        val token = Config.token(this)
        // Paired phones see their own merchant's screen; the legacy shared token opens Arun's dashboard.
        if (token.startsWith("obs_")) b.web.loadUrl("$base/phone#" + URLEncoder.encode(token, "UTF-8"))
        else b.web.loadUrl("$base/dashboard")
    }

    private fun showSetup(keepStatus: Boolean = false) {
        b.web.visibility = View.GONE
        b.setup.visibility = View.VISIBLE
        b.token.setText(Config.token(this))
        if (!keepStatus && Config.wasUnlinked(this)) b.status.text = CreditReporter.UNLINKED_MSG
    }

    // Push access is optional but catches PhonePe / Paytm / GPay Business alerts too.
    private fun askPushAccess() {
        if (askedPush || NotificationService.isEnabled(this) || isFinishing || isDestroyed) return
        askedPush = true
        AlertDialog.Builder(this)
            .setTitle("Turn on notification access")
            .setMessage("Allow notification access so PhonePe / Paytm / GPay Business alerts also confirm payments.")
            .setPositiveButton("Open settings") { _, _ -> openPushSettings() }
            .setNegativeButton("Not now", null)
            .show()
    }

    private fun openPushSettings() {
        runCatching { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
    }

    private fun requestPerms() {
        val perms = mutableListOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        val missing = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty())
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Tell the server right away whether SMS is allowed.
        if (Config.isConfigured(this))
            lifecycleScope.launch(Dispatchers.IO) { CreditReporter.ping(applicationContext) }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (b.web.visibility == View.VISIBLE && b.web.canGoBack()) b.web.goBack()
        else super.onBackPressed()
    }
}
