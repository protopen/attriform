# Landing page

`index.html` is the home page, written for small businesses in general. `manufacturing.html` is the version for US manufacturers that quote from a web RFQ form (machine shops, fabricators, molders, contract manufacturers, machinery makers), live at `/manufacturing`. The old `/v1` and `/main` URLs redirect to the home page.

`index.html` is the complete page in one file: HTML with inline styles and scripts, no build step. Fonts load from Google Fonts (Bricolage Grotesque, IBM Plex Sans, IBM Plex Mono) with system fallbacks.

## Replace these placeholders

Search the file for each bracketed item:

- `[Your Brand]`: nav, footer and page title
- `[your@email.com]`: footer link (appears twice: the link and its text)
- `[X]`: how many business days until you send the free scan
- `[FOUNDING PRICE]`: founding-client offer
- `[PLATFORMS YOU SUPPORT]`: FAQ answer, for example "Shopify, WooCommerce and BigCommerce"
- `[Product A]`, `[Product B]`: example insights in the leak-free store section
- `[YOUR_FORM_ENDPOINT]`: where scan requests are sent (see below)

The dollar figures, percentages and order counts in the hero card and previews are illustrative. Swap them for real numbers once you have client results.

## Connect the scan form

The form posts two fields, `store_url` and `email`. The simplest option is a form service such as Formspree, Basin or Tally: create a form there, then replace `[YOUR_FORM_ENDPOINT]` with the URL they give you. If you build the page in Webflow, Framer or similar, use that tool's native form block instead and keep the same two fields.

## Meta Pixel and Conversions API

Both pages load the Meta Pixel (dataset `1082089381523575`) in the `<head>`. `metaTrack(name)` sends each event twice with the same event ID: once from the browser pixel and once through `api/meta-capi.js`, a Vercel function that adds the visitor's IP and user agent and forwards the event to Meta's Conversions API. Meta deduplicates the pair.

Events sent:

- `PageView`: every page load
- `Contact`: a "Book a call" button is clicked
- `Schedule`: a call is booked in the Calendly popup or badge

Every event carries `external_id`, an anonymous visitor ID kept in the `af_vid` cookie for a year, plus the visitor's country, region, city and postcode from Vercel's IP geolocation (all hashed before they go to Meta). Meta's [Parameter Builder](https://github.com/meta/capi-param-builder/tree/main/client_js) (loaded from jsDelivr, pinned to 1.3.3) sets `_fbp` and `_fbc` in Meta's recommended format, including the click ID that Facebook and Instagram's in-app browsers provide when the link has no `fbclid`; server events wait up to 2.5 seconds for it. If both it and the pixel are blocked, the page sets `_fbp` itself so server events still carry one. Events also include `referrer_url`. On `Schedule`, the server looks up the booker in Calendly's API and adds their email, name and phone, normalised and SHA-256 hashed. Phone comes from Calendly's SMS reminder number or from any booking question that mentions phone, so add a phone question to the Calendly event type to get it. The details always come from Calendly, never from the browser, and only bookings made in the last hour count.

Vercel environment variables:

- `META_CAPI_TOKEN` (required): access token from Events Manager → dataset → Settings → Conversions API. Without it, the pixel still works and the server copy is skipped.
- `CALENDLY_TOKEN` (optional): Calendly personal access token (Integrations → API & Webhooks). Without it, `Schedule` is sent without the booker's details.
- `META_TEST_EVENT_CODE` (optional): code from Events Manager → Test events, so server events show up there while testing. Remove it afterwards.

## Contact form

Every "Book a call" button has a "Contact us" button next to it, which opens a small form (name, work email, company name, company website, all required). `api/contact.js` emails each submission through Resend to `ritwik@attriform.com`, with where the visitor first came from, how they came this visit, their visit count and the pages they read (recorded in the visitor's browser under `af_journey`). On the live site it also sends Meta a `Lead` event with the hashed email and name, deduplicated with the browser's pixel `Lead`. Bots are filtered with a hidden field and a minimum fill time.

Vercel environment variables:

- `RESEND_API_KEY` (required): Resend API key with sending access for attriform.com. The domain's DNS records are at GoDaddy.
- `CONTACT_TO` (optional): where submissions go instead of `ritwik@attriform.com`.

Meta tracking and the server `Lead` only run on attriform.com, so preview deployments don't send events to Meta. Shared Meta code is in `lib/meta.js`.

## Colours

- Ink: `#12151A`
- Background: `#F5F6F3`
- Accent (buttons, labels): `#2B3FCC`
- Highlight (marker effect, badges): `#F2DC4B`

To change the accent or highlight, find and replace the hex value throughout the file.

## Hosting

Any static host works: Netlify, Vercel, Cloudflare Pages or GitHub Pages. Upload `index.html` as the site's home page.

## Deploying

This repo is connected to Vercel. Every push to `main` redeploys the site automatically, so editing `index.html` and pushing is all it takes to update it. No build command or framework is needed; Vercel serves `index.html` as a static file.
