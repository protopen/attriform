// Meta Conversions API relay. The pages call metaTrack(name), which fires the browser pixel and POSTs the
// same event here; this function adds the visitor's IP and user agent and forwards it to Meta server-side.
// Both copies share event_id, so Meta deduplicates them. Shared helpers and Meta settings are in lib/meta.js.
//
// Environment variables (Vercel → Settings → Environment Variables), besides the Meta ones in lib/meta.js:
//   CALENDLY_TOKEN         optional. Calendly personal access token. On "Schedule", the booker's email and name
//                          are looked up from Calendly (never trusted from the browser) and sent hashed.

const { ALLOWED_HOSTS, hostOf, hash, baseUserData, sendEvent } = require("../lib/meta");

const EVENTS = new Set(["PageView", "Contact", "Schedule"]);
const INVITEE_URI = /^https:\/\/api\.calendly\.com\/scheduled_events\/[A-Za-z0-9-]+\/invitees\/[A-Za-z0-9-]+$/;
const MAX_BOOKING_AGE_MS = 60 * 60 * 1000;

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
  if (!process.env.META_CAPI_TOKEN) return res.status(503).json({ error: "META_CAPI_TOKEN is not set" });

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

  const userData = baseUserData(req, body);
  if (body.event_name === "Schedule") {
    Object.assign(userData, await lookUpInvitee(body.calendly_invitee, String(req.headers["x-vercel-ip-country"] || "").toLowerCase()));
  }

  const ok = await sendEvent({ name: body.event_name, id: body.event_id, sourceUrl, referrerUrl: body.referrer_url, userData });
  return ok ? res.status(204).end() : res.status(502).json({ error: "meta rejected the event" });
};
