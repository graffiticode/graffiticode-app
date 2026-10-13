// SendGrid email sender.
//
// Plain REST + bearer auth rather than @sendgrid/mail, for the same reasons
// alert-sms.ts skips the twilio package: one endpoint, no dependency, nothing
// for Next.js standalone output-tracing to miss.
//
// Unconfigured is a supported state, not an error: the message is logged instead
// of sent. Recipient addresses never reach the logs (privacy contract).

const API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM = process.env.ALERT_EMAIL_FROM || "";

/** Operator recipients, comma-separated in ALERT_EMAIL_TO. */
export function operatorEmails(): string[] {
  return (process.env.ALERT_EMAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function isEmailConfigured(): boolean {
  return !!(API_KEY && FROM);
}

export interface EmailResult {
  sent: boolean;
  /** Why it wasn't sent, when it wasn't. */
  reason?: string;
}

/**
 * Send one plain-text, high-priority email per recipient — separate messages,
 * so an operator address is never exposed to a customer.
 *
 * Never throws: a failed alert must not fail the create that triggered it.
 */
export async function sendEmail({
  to,
  subject,
  text,
}: {
  to: string[];
  subject: string;
  text: string;
}): Promise<EmailResult> {
  const seen = new Set<string>();
  const recipients = to.map((a) => a.trim()).filter((a) => {
    const key = a.toLowerCase();
    if (!a || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (recipients.length === 0) return { sent: false, reason: "no_recipients" };

  if (!isEmailConfigured()) {
    console.log(`[alert-email] not configured; ${recipients.length} recipient(s); message follows\n${subject}\n\n${text}`);
    return { sent: false, reason: "not_configured" };
  }

  let sent = 0;
  for (const email of recipients) {
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: { email: FROM },
          personalizations: [{ to: [{ email }] }],
          subject,
          headers: { "X-Priority": "1", Importance: "high" },
          content: [{ type: "text/plain", value: text }],
        }),
      });
      if (!res.ok) {
        // Status only: SendGrid's error body can echo the recipient address.
        console.error(`[alert-email] send failed ${res.status}`);
        continue;
      }
      sent++;
    } catch (err) {
      console.error("[alert-email] send threw", err);
    }
  }

  return sent > 0 ? { sent: true } : { sent: false, reason: "send_failed" };
}
