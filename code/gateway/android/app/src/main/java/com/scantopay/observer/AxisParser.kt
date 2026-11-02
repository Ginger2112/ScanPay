package com.scantopay.observer

/**
 * Parses an Axis Bank *credit* alert (SMS or app-push text) into amount + UTR.
 * Ported from the server's lib/parse-axis.js. Axis sends UPI account credits by
 * SMS, e.g.:
 *   "INR 899.00 credited to A/c no. XX1234 on 22-10-26 thru UPI/P2A/412345678901/NAME - Axis Bank"
 * Add your exact real SMS wording at the top of the pattern lists if needed.
 */
object AxisParser {

    data class Credit(val amount: Double, val utr: String?, val payer: String? = null)

    // AU format: "UPI/CR/<utr>/APARNA ROBIN" -> payer name after the UTR
    private val PAYER = Regex("""UPI/CR/\d{9,22}/([A-Za-z][A-Za-z .]{0,40})""", RegexOption.IGNORE_CASE)

    private val CREDIT = Regex("""\b(credited|credit|received|added to)\b""", RegexOption.IGNORE_CASE)
    private val DEBIT = Regex("""\b(debited|debit|spent|withdrawn|paid to)\b""", RegexOption.IGNORE_CASE)

    private val AMOUNT = listOf(
        Regex("""Credited\s+(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*\.[0-9]{2})""", RegexOption.IGNORE_CASE), // AU Bank
        Regex("""(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*\.[0-9]{2})""", RegexOption.IGNORE_CASE),
        Regex("""(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*)""", RegexOption.IGNORE_CASE),
        Regex("""([0-9][0-9,]*\.[0-9]{2})\s*(?:credited|cr)\b""", RegexOption.IGNORE_CASE)
    )

    private val UTR = listOf(
        Regex("""UPI/CR/([0-9]{9,22})""", RegexOption.IGNORE_CASE),          // AU Bank: UPI/CR/512559647968/NAME
        Regex("""UPI/(?:[A-Z0-9]+/)?([0-9]{9,22})""", RegexOption.IGNORE_CASE),
        Regex("""UPI(?:\s*(?:Ref(?:erence)?)\s*(?:no\.?)?)[:\s/-]*([0-9]{9,22})""", RegexOption.IGNORE_CASE),
        Regex("""\bUTR[:\s/-]*([0-9]{9,22})""", RegexOption.IGNORE_CASE),
        Regex("""\bRRN[:\s/-]*([0-9]{9,22})""", RegexOption.IGNORE_CASE),
        Regex("""\bRef(?:erence)?\s*(?:no\.?|id)?[:\s/-]*([0-9]{12,22})""", RegexOption.IGNORE_CASE)
    )

    /** Does this SMS sender look like the bank's alert? (e.g. JK-AUBANK, AX-AUBANK) */
    fun isAxisSender(sender: String): Boolean =
        Regex("""aubank|au-?bank|axisbk|idbibk|idbi""", RegexOption.IGNORE_CASE).containsMatchIn(sender)

    private val CREDITED = Regex("""\bcredited\b""", RegexOption.IGNORE_CASE)

    fun parse(raw: String?): Credit? {
        if (raw.isNullOrBlank()) return null
        val t = raw.replace(Regex("""\s+"""), " ").trim()
        if (!CREDIT.containsMatchIn(t)) return null
        if (DEBIT.containsMatchIn(t) && !CREDITED.containsMatchIn(t)) return null

        val amtStr = AMOUNT.firstNotNullOfOrNull { it.find(t)?.groupValues?.get(1) } ?: return null
        val amount = amtStr.replace(",", "").toDoubleOrNull() ?: return null
        if (amount <= 0) return null

        val utr = UTR.firstNotNullOfOrNull { it.find(t)?.groupValues?.get(1) }
        val payer = PAYER.find(t)?.groupValues?.get(1)?.trim()?.trimEnd('.')?.ifBlank { null }
        return Credit(amount, utr, payer)
    }
}
