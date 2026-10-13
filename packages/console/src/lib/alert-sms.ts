// Twilio SMS sender.
//
// Plain REST + basic auth rather than the `twilio` npm package: one endpoint,
// no dependency, and nothing for Next.js standalone output-tracing to miss (see
// the header on src/lib/generation-queue.ts for what SDKs cost us here).
//
// Unconfigured is a supported state, not an error. Local dev and preview
// deploys log the message instead of sending it, so the digest can be developed
// end to end without a Twilio account or a phone buzzing.

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const FROM = process.env.TWILIO_FROM || "";
const TO = process.env.ALERT_SMS_TO || "";

export function isSmsConfigured(): boolean {
  return !!(ACCOUNT_SID && AUTH_TOKEN && FROM && TO);
}

export interface SmsResult {
  sent: boolean;
  /** Why it wasn't sent, when it wasn't. */
  reason?: string;
}

/**
 * Send one SMS. Recipients are comma-separated in ALERT_SMS_TO.
 *
 * Never throws: a failed alert must not fail the job that produced it, or a
 * Twilio outage turns into a Cloud Scheduler retry storm.
 */
export async function sendSms(body: string): Promise<SmsResult> {
  if (!isSmsConfigured()) {
    console.log("[alert-sms] not configured; message follows\n" + body);
    return { sent: false, reason: "not_configured" };
  }

  const recipients = TO.split(",").map((n) => n.trim()).filter(Boolean);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");

  let sent = 0;
  for (const to of recipients) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: FROM, Body: body }).toString(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[alert-sms] send failed ${res.status} ${text.slice(0, 300)}`);
        continue;
      }
      sent++;
    } catch (err) {
      console.error("[alert-sms] send threw", err);
    }
  }

  return sent > 0 ? { sent: true } : { sent: false, reason: "send_failed" };
}
