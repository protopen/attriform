// Shared Meta Conversions API helpers, used by api/meta-capi.js (page events) and api/contact.js (the contact form's Lead).
//
// Environment variables (Vercel → Settings → Environment Variables):
//   META_CAPI_TOKEN        required. Access token from Events Manager → dataset → Settings → Conversions API.
//   META_TEST_EVENT_CODE   optional. Code from Events Manager → Test events; remove it once testing is done.

const crypto = require("crypto");

const PIXEL_ID = process.env.META_PIXEL_ID || "1082089381523575";
const GRAPH_URL = `https://graph.facebook.com/v23.0/${PIXEL_ID}/events`;
const ALLOWED_HOSTS = /(^|\.)attriform\.com$|\.vercel\.app$|^localhost$/;

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

// Matching details every event carries: IP, user agent, browser and click IDs, visitor ID and location.
function baseUserData(req, body) {
  const ip = String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "").split(",")[0].trim();
  const userData = { client_user_agent: req.headers["user-agent"] || "" };
  if (ip) userData.client_ip_address = ip;
  if (typeof body.fbp === "string" && body.fbp) userData.fbp = body.fbp;
  if (typeof body.fbc === "string" && body.fbc) userData.fbc = body.fbc;
  if (typeof body.external_id === "string" && body.external_id) userData.external_id = hash(body.external_id.slice(0, 100));
  Object.assign(userData, geoFromHeaders(req.headers));
  return userData;
}

// Send one website event. Returns true if Meta accepted it.
async function sendEvent({ name, id, sourceUrl, referrerUrl, userData }) {
  const payload = {
    data: [{
      event_name: name,
      event_time: Math.floor(Date.now() / 1000),
      event_id: String(id).slice(0, 100),
      event_source_url: String(sourceUrl || "").slice(0, 2000),
      referrer_url: typeof referrerUrl === "string" && referrerUrl ? referrerUrl.slice(0, 2000) : undefined,
      action_source: "website",
      user_data: userData,
    }],
    access_token: process.env.META_CAPI_TOKEN,
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
      return false;
    }
    return true;
  } catch (err) {
    console.error("Meta CAPI request failed", err);
    return false;
  }
}

module.exports = { ALLOWED_HOSTS, hostOf, hash, baseUserData, sendEvent };
