package com.scantopay.observer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts the observer after the phone reboots, if it is paired. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val a = intent.action ?: return
        if (a != Intent.ACTION_BOOT_COMPLETED && a != "android.intent.action.QUICKBOOT_POWERON") return
        if (!Config.isConfigured(ctx)) return
        runCatching { ObserverService.start(ctx) }
    }
}
