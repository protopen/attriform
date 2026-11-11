// "Contact us" form. Emails each submission through Resend, with where the visitor came from, the pages they read
// and how many times they visited, then sends Meta a "Schedule" event (labelled "Contact form") with the hashed
// email and name, like a Calendly booking. The browser fires the matching pixel Schedule with the same event_id,
// so Meta counts it once.
//
// Environment variables (Vercel → Settings → Environment Variables), besides the Meta ones in lib/meta.js:
//   RESEND_API_KEY   required. Resend API key with sending access for attriform.com.
//   CONTACT_TO       optional. Where submissions go. Defaults to ritwik@attriform.com.

const { ALLOWED_HOSTS, hostOf, hash, baseUserData, sendEvent } = require("../lib/meta");

const FROM = "Attriform website <forms@attriform.com>";
const TO = process.env.CONTACT_TO || "ritwik@attriform.com";
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const WEBSITE = /^(https?:\/\/)?[^\s.\/]+(\.[^\s.\/]+)+(\/\S*)?$/i;

const clean = (v, max = 200) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Where the visitor came from, from UTM tags, ad click IDs or the referring site.
function describeSource(s) {
  if (!s || typeof s !== "object") return "Unknown";
  if (s.utm_source) return [s.utm_source, s.utm_medium, s.utm_campaign && `campaign "${s.utm_campaign}"`, s.utm_term && `keyword "${s.utm_term}"`].filter(Boolean).map((x) => clean(x, 80)).join(", ");
  if (s.gclid) return "Google Ads";
  if (s.fbclid) return "Facebook or Instagram (ad or post)";
  const host = hostOf(s.referrer || "").replace(/^www\./, "");
  if (!host || ALLOWED_HOSTS.test(host)) return "Direct (typed the address or a bookmark)";
  const known = { "google.": "Google search", "bing.com": "Bing search", "duckduckgo.com": "DuckDuckGo search", "linkedin.com": "LinkedIn", "lnkd.in": "LinkedIn", "facebook.com": "Facebook", "instagram.com": "Instagram", "t.co": "X (Twitter)", "x.com": "X (Twitter)", "youtube.com": "YouTube", "reddit.com": "Reddit", "chatgpt.com": "ChatGPT", "perplexity.ai": "Perplexity" };
  for (const k of Object.keys(known)) if (host.includes(k)) return `${known[k]} (${host})`;
  return `Referral from ${host}`;
}

function describeJourney(j, headers) {
  j = j && typeof j === "object" ? j : {};
  const pages = Array.isArray(j.pages) ? j.pages.slice(-15).map((p) => clean(p && p.title ? p.title : p && p.path, 60)).filter(Boolean) : [];
  const first = Date.parse(j.first_seen);
  const days = Number.isFinite(first) ? Math.max(0, Math.round((Date.now() - first) / 86400000)) : null;
  const visits = Number.isFinite(+j.visits) && +j.visits > 0 ? Math.round(+j.visits) : 1;
  const city = (() => { try { return decodeURIComponent(headers["x-vercel-ip-city"] || ""); } catch { return ""; } })();
  const place = [city, headers["x-vercel-ip-country-region"], headers["x-vercel-ip-country"]].filter(Boolean).join(", ");
  const device = /Mobi|iPhone|Android/i.test(headers["user-agent"] || "") ? "Phone" : "Desktop";
  return {
    "Came from": describeSource(j.first_source),
    "This visit from": describeSource(j.last_source),
    "Visits": visits === 1 ? "1st visit" : `${visits} visits${days != null ? ` over ${days} day${days === 1 ? "" : "s"}` : ""}`,
    "Pages read": pages.length ? pages.join(" → ") : "Unknown",
    "From": [device, place].filter(Boolean).join(", "),
  };
}

async function sendEmail({ name, email, company, website, journey, page }) {
  const rows = { Name: name, Email: email, Company: company, Website: website, ...journey, "Sent from": page };
  const html = `<h2 style="font-family:Arial,sans-serif;margin:0 0 12px">New contact from attriform.com</h2>
<table cellpadding="8" style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">${Object.entries(rows)
    .map(([k, v]) => `<tr><td style="color:#766C70;border-bottom:1px solid #E6DFE0;white-space:nowrap">${esc(k)}</td><td style="color:#1C1518;border-bottom:1px solid #E6DFE0">${esc(v)}</td></tr>`)
    .join("")}</table>`;
  const text = Object.entries(rows).map(([k, v]) => `${k}: ${v}`).join("\n");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [TO], reply_to: email, subject: `New contact: ${name}, ${company}`, html, text }),
  });
  if (!r.ok) {
    console.error("Resend error", r.status, await r.text());
    return false;
  }
  return true;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: "RESEND_API_KEY is not set" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "bad request" });

  const page = clean(body.event_source_url, 2000);
  const origin = req.headers.origin || req.headers.referer || page;
  if (!ALLOWED_HOSTS.test(hostOf(origin)) || !ALLOWED_HOSTS.test(hostOf(page))) {
    return res.status(403).json({ error: "origin not allowed" });
  }

  // Bots: a hidden field people never fill in, and forms submitted within 2 seconds of opening. Reply OK so they don't retry.
  if (clean(body.nickname) || (Number(body.elapsed_ms) >= 0 && Number(body.elapsed_ms) < 2000)) return res.status(200).json({ ok: true });

  const name = clean(body.name, 100), email = clean(body.email, 200).toLowerCase(), company = clean(body.company, 150), website = clean(body.website, 300);
  if (!name || !EMAIL.test(email) || !company || !WEBSITE.test(website)) return res.status(400).json({ error: "Please fill in every field." });

  const sent = await sendEmail({ name, email, company, website, journey: describeJourney(body.journey, req.headers), page });
  if (!sent) return res.status(502).json({ error: "Couldn't send your message." });

  // Meta "Schedule", only from the live site so preview deployments don't add test data.
  if (process.env.META_CAPI_TOKEN && typeof body.event_id === "string" && /(^|\.)attriform\.com$/.test(hostOf(page))) {
    const parts = name.split(/\s+/);
    const userData = { ...baseUserData(req, body), em: hash(email), fn: hash(parts[0]) };
    if (parts.length > 1) userData.ln = hash(parts[parts.length - 1]);
    await sendEvent({ name: "Schedule", id: body.event_id, sourceUrl: page, referrerUrl: body.referrer_url, userData, customData: { content_name: "Contact form" } });
  }
  return res.status(200).json({ ok: true });
};
