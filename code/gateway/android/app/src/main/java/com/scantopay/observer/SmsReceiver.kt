package com.scantopay.observer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import java.util.concurrent.atomic.AtomicInteger

/** Primary detector: forwards incoming bank SMS to ScanPay (server parses + matches). */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        // A long SMS arrives as multiple parts — join them.
        val bySender = msgs.groupBy { it.originatingAddress ?: "" }
        if (bySender.isEmpty()) return
        // Keep the process alive until every post is sent (or queued).
        val pending = goAsync()
        val left = AtomicInteger(bySender.size)
        for ((sender, parts) in bySender) {
            val body = parts.joinToString("") { it.messageBody ?: "" }
            CreditReporter.handle(ctx, sender, body, "sms") { // filters to bank messages
                if (left.decrementAndGet() == 0) pending.finish()
            }
        }
    }
}
