/**
 * Wren × Cloudflare Email Routing
 *
 * Receives mail for your domain on Cloudflare's MX servers and hands the
 * original message (raw MIME) to Wren's inbound webhook.
 *
 * Secrets / vars:
 *   WREN_INBOUND_URL  (required) – the inbound URL shown in Wren → Admin → Providers → Cloudflare
 *   FALLBACK_FORWARD  (optional) – a verified destination address to forward to if Wren is unreachable
 */
export default {
  async email(message, env) {
    if (!env.WREN_INBOUND_URL) throw new Error('WREN_INBOUND_URL is not configured');

    // message.raw is a single-use stream; buffer it once.
    const raw = await new Response(message.raw).arrayBuffer();

    let res;
    try {
      res = await fetch(env.WREN_INBOUND_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'message/rfc822',
          'X-Mail-From': message.from,
          'X-Rcpt-To': message.to,
        },
        body: raw,
      });
    } catch (err) {
      return fallback(message, env, `network error: ${err}`);
    }

    if (res.ok) {
      const result = await res.json().catch(() => null);
      // Wren accepted nothing: tell the sender at SMTP time instead of silently dropping.
      if (result && Array.isArray(result.accepted) && result.accepted.length === 0 && result.rejected?.length) {
        message.setReject(`550 5.1.1 ${result.rejected.map((r) => `${r.rcpt}: ${r.reason}`).join('; ')}`);
      }
      return;
    }

    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      message.setReject(`Message refused (${res.status})`);
      return;
    }
    return fallback(message, env, `HTTP ${res.status}`);
  },
};

async function fallback(message, env, reason) {
  if (env.FALLBACK_FORWARD) {
    await message.forward(env.FALLBACK_FORWARD, new Headers({ 'X-Wren-Fallback': reason }));
    return;
  }
  // Throwing makes Cloudflare return a temporary failure, so the sender retries later.
  throw new Error(`Wren inbound failed: ${reason}`);
}
