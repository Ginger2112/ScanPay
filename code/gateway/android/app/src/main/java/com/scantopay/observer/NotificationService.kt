package com.scantopay.observer

import android.content.Context
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/** Reads bank-app and UPI business-app push notifications (PhonePe/Paytm/GPay Business, BharatPe …). */
class NotificationService : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val pkg = sbn.packageName ?: return
        if (!isBankApp(pkg)) return
        val extras = sbn.notification?.extras ?: return
        val title = extras.getCharSequence("android.title")?.toString() ?: ""
        val text = extras.getCharSequence("android.text")?.toString() ?: ""
        val big = extras.getCharSequence("android.bigText")?.toString() ?: ""
        val body = listOf(title, big.ifBlank { text }).joinToString(" ")
        CreditReporter.handle(applicationContext, pkg, body, "push") // filters to money messages
    }

    private val APPS = Regex("""axis|idbi|hdfc|icici|sbi|yono|kotak|baroda|bob|pnb|canara|union|aubank|indus|yesbank|phonepe|paytm|nbu.paisa|gpay|bharatpe|bhim|upi|bank|fedmobile|federal|idfc|rbl|bandhan|jupiter|fi\.money|slice|cred|amazon|mobikwik|freecharge|airtel""",
        RegexOption.IGNORE_CASE)

    private fun isBankApp(pkg: String): Boolean = APPS.containsMatchIn(pkg)

    companion object {
        /** Has the user granted notification access to our listener? */
        fun isEnabled(ctx: Context): Boolean {
            val list = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
            return list.split(':').any { it.substringBefore('/') == ctx.packageName }
        }
    }
}
