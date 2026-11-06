// Meta Conversions API relay. The pages call metaTrack(name), which fires the browser pixel and POSTs the
// same event here; this function adds the visitor's IP and user agent and forwards it to Meta server-side.
// Both copies share event_id, so Meta deduplicates them.
//
// Environment variables (Vercel → Settings → Environment Variables):
//   META_CAPI_TOKEN        required. Access token from Events Manager → dataset → Settings → Conversions API.
//   META_TEST_EVENT_CODE   optional. Code from Events Manager → Test events; remove it once testing is done.

const PIXEL_ID = process.env.META_PIXEL_ID || "1082089381523575";
const GRAPH_URL = `https://graph.facebook.com/v23.0/${PIXEL_ID}/events`;
const EVENTS = new Set(["PageView", "Contact", "Schedule", "Lead"]);
const ALLOWED_HOSTS = /(^|\.)attriform\.com$|\.vercel\.app$|^localhost$/;

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const token = process.env.META_CAPI_TOKEN;
  if (!token) return res.status(503).json({ error: "META_CAPI_TOKEN is not set" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || !EVENTS.has(body.event_name) || typeof body.event_id !== "string") {
    return res.status(400).json({ error: "bad event" });
  }

  // Only accept events sent from our own pages.
  const sourceUrl = String(body.event_source_url || "");
  const origin = req.headers.origin || req.headers.referer || sourceUrl;
  if (!ALLOWED_HOSTS.test(hostOf(origin)) || !ALLOWED_HOSTS.test(hostOf(sourceUrl))) {
    return res.status(403).json({ error: "origin not allowed" });
  }

  const ip = String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "").split(",")[0].trim();
  const userData = { client_user_agent: req.headers["user-agent"] || "" };
  if (ip) userData.client_ip_address = ip;
  if (typeof body.fbp === "string" && body.fbp) userData.fbp = body.fbp;
  if (typeof body.fbc === "string" && body.fbc) userData.fbc = body.fbc;

  const payload = {
    data: [{
      event_name: body.event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id: body.event_id.slice(0, 100),
      event_source_url: sourceUrl.slice(0, 2000),
      action_source: "website",
      user_data: userData,
    }],
    access_token: token,
  };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  try {
    const r = await fetch(GRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      console.error("Meta CAPI error", r.status, await r.text());
      return res.status(502).json({ error: "meta rejected the event" });
    }
    return res.status(204).end();
  } catch (err) {
    console.error("Meta CAPI request failed", err);
    return res.status(502).json({ error: "meta request failed" });
  }
};
