// Meta Conversions API relay. The pages call metaTrack(name), which fires the browser pixel and POSTs the
// same event here; this function adds the visitor's IP and user agent and forwards it to Meta server-side.
// Both copies share event_id, so Meta deduplicates them.
//
// Environment variables (Vercel → Settings → Environment Variables):
//   META_CAPI_TOKEN        required. Access token from Events Manager → dataset → Settings → Conversions API.
//   META_TEST_EVENT_CODE   optional. Code from Events Manager → Test events; remove it once testing is done.
//   CALENDLY_TOKEN         optional. Calendly personal access token. On "Schedule", the booker's email and name
//                          are looked up from Calendly (never trusted from the browser) and sent hashed.

const crypto = require("crypto");

const PIXEL_ID = process.env.META_PIXEL_ID || "1082089381523575";
const GRAPH_URL = `https://graph.facebook.com/v23.0/${PIXEL_ID}/events`;
const EVENTS = new Set(["PageView", "Contact", "Schedule", "Lead"]);
const ALLOWED_HOSTS = /(^|\.)attriform\.com$|\.vercel\.app$|^localhost$/;

const INVITEE_URI = /^https:\/\/api\.calendly\.com\/scheduled_events\/[A-Za-z0-9-]+\/invitees\/[A-Za-z0-9-]+$/;
const MAX_BOOKING_AGE_MS = 60 * 60 * 1000;

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

// Meta wants customer details normalised (trimmed, lower case) and SHA-256 hashed.
function hash(value) {
  const v = String(value || "").trim().toLowerCase();
  return v ? crypto.createHash("sha256").update(v).digest("hex") : undefined;
}

// Visitor location from Vercel's IP geolocation headers, normalised the way Meta asks (lower case, no spaces or punctuation).
function geoFromHeaders(headers) {
  const get = (k) => { try { return decodeURIComponent(headers[k] || ""); } catch { return ""; } };
  const country = get("x-vercel-ip-country").toLowerCase();
  const geo = {
    country: hash(country),
    st: hash(get("x-vercel-ip-country-region").toLowerCase().replace(/[^a-z0-9]/g, "")),
    ct: hash(get("x-vercel-ip-city").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")),
    zp: hash((country === "us" ? get("x-vercel-ip-postal-code").slice(0, 5) : get("x-vercel-ip-postal-code")).toLowerCase().replace(/[^a-z0-9]/g, "")),
  };
  for (const k of Object.keys(geo)) if (!geo[k]) delete geo[k];
  return geo;
}

// Digits only, with country code. A bare 10-digit number from a US or Canadian visitor gets the leading 1.
function normalisePhone(raw, country) {
  const hadPlus = /^\s*\+/.test(raw);
  let digits = String(raw || "").replace(/\D/g, "");
  if (!hadPlus && digits.length === 10 && (country === "us" || country === "ca")) digits = "1" + digits;
  return digits.length >= 8 ? digits : "";
}

// Fetch the booker from Calendly. Only bookings made in the last hour count, so an old invitee link can't be replayed.
async function lookUpInvitee(uri, country) {
  const token = process.env.CALENDLY_TOKEN;
  if (!token || typeof uri !== "string" || !INVITEE_URI.test(uri)) return null;
  try {
    const r = await fetch(uri, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      console.error("Calendly lookup failed", r.status, await r.text());
      return null;
    }
    const invitee = (await r.json()).resource || {};
    if (Date.now() - Date.parse(invitee.created_at) > MAX_BOOKING_AGE_MS) return null;
    const parts = String(invitee.name || "").trim().split(/\s+/);
    const first = invitee.first_name || parts[0];
    const last = invitee.last_name || (parts.length > 1 ? parts[parts.length - 1] : "");
    const user = { em: hash(invitee.email), fn: hash(first), ln: hash(last) };
    // Phone comes from SMS reminders or from any booking question that asks for a phone number.
    const answers = Array.isArray(invitee.questions_and_answers) ? invitee.questions_and_answers : [];
    const asked = answers.find((qa) => /phone|mobile|cell|whatsapp/i.test(qa.question || "") && qa.answer);
    const phone = normalisePhone(invitee.text_reminder_number || (asked && asked.answer) || "", country);
    if (phone) user.ph = hash(phone);
    for (const k of Object.keys(user)) if (!user[k]) delete user[k];
    return user;
  } catch (err) {
    console.error("Calendly lookup error", err);
    return null;
  }
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
  if (typeof body.external_id === "string" && body.external_id) userData.external_id = hash(body.external_id.slice(0, 100));
  Object.assign(userData, geoFromHeaders(req.headers));
  if (body.event_name === "Schedule") {
    Object.assign(userData, await lookUpInvitee(body.calendly_invitee, String(req.headers["x-vercel-ip-country"] || "").toLowerCase()));
  }

  const payload = {
    data: [{
      event_name: body.event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id: body.event_id.slice(0, 100),
      event_source_url: sourceUrl.slice(0, 2000),
      referrer_url: typeof body.referrer_url === "string" && body.referrer_url ? body.referrer_url.slice(0, 2000) : undefined,
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
    // Meta's reply (events_received, fbtrace_id) plus whether test mode is on, for checking the setup.
    const meta = await r.json().catch(() => ({}));
    return res.status(200).json({
      events_received: meta.events_received,
      fbtrace_id: meta.fbtrace_id,
      test_mode: Boolean(process.env.META_TEST_EVENT_CODE),
    });
  } catch (err) {
    console.error("Meta CAPI request failed", err);
    return res.status(502).json({ error: "meta request failed" });
  }
};
