package com.scantopay.observer

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Foreground service: keeps a persistent notification so Android doesn't kill the
 * app, letting the SMS receiver and notification listener keep working in the
 * background. The receivers do the actual detection; this just keeps us alive.
 */
class ObserverService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val ch = "scantopay_observer"
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(ch, "Observer", NotificationManager.IMPORTANCE_LOW)
        )
        val n = NotificationCompat.Builder(this, ch)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("ScanPay is confirming payments")
            .setContentText("Watching for bank and UPI credit alerts")
            .setOngoing(true)
            .build()
        startForeground(1, n)
        // Unlinked or never paired: nothing to watch for.
        if (!Config.isConfigured(this)) { stopSelf(); return START_NOT_STICKY }
        startHeartbeat()
        return START_STICKY
    }

    // Tells the server "this phone is alive" every 10 minutes (plus what it can see), then retries queued messages.
    private var beat: Job? = null
    private fun startHeartbeat() {
        if (beat?.isActive == true) return
        beat = CoroutineScope(Dispatchers.IO).launch {
            while (isActive) {
                val code = CreditReporter.ping(applicationContext)
                if (code == 401 || !Config.isConfigured(applicationContext)) break // unlinked: service is stopping
                CreditReporter.flush(applicationContext)
                delay(10 * 60 * 1000L)
            }
        }
    }

    override fun onDestroy() {
        beat?.cancel()
        super.onDestroy()
    }

    companion object {
        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, ObserverService::class.java))
        }
    }
}
