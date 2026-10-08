import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GOOGLE_SCOPES, googleRedirectUri, SERVER_NAME, supportEmail, type AppConfig } from "./config.js";

export function logoBytes() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "logo.jpg"),
    join(here, "../logo.jpg"),
    join(here, "../../logo.jpg")
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path);
    } catch {
      continue;
    }
  }
  return null;
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
}

function page(config: AppConfig, title: string, body: string, index = true) {
  const mcp = `${config.appBaseUrl}/mcp`;
  const email = supportEmail();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/jpeg" href="/logo.jpg">
<link rel="apple-touch-icon" href="/logo.jpg">
${index ? "" : `<meta name="robots" content="noindex">`}
<style>
:root { color-scheme: dark; --bg:#070807; --panel:#101611; --line:#234232; --text:#e8f6ec; --muted:#9db5a6; --green:#3ddc84; --ink:#062214; }
* { box-sizing: border-box; }
body { margin:0; background:radial-gradient(1200px 500px at 50% -10%, #143222 0%, var(--bg) 55%); color:var(--text); font:17px/1.6 ui-sans-serif, system-ui, sans-serif; }
a { color:var(--green); }
header, main, footer { width:min(980px, calc(100% - 32px)); margin-inline:auto; }
header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:22px 0; flex-wrap:wrap; }
.brand { display:flex; align-items:center; gap:10px; color:inherit; text-decoration:none; font-weight:650; }
.brand img { width:36px; height:36px; border-radius:8px; }
nav { display:flex; gap:16px; flex-wrap:wrap; }
nav a { color:var(--text); text-decoration:none; }
nav a:hover { color:var(--green); }
.hero { display:grid; grid-template-columns:280px 1fr; gap:36px; align-items:center; padding:18px 0 42px; }
.hero img { width:280px; height:280px; border-radius:24px; }
h1, h2 { font-family:Palatino, "Iowan Old Style", Georgia, serif; font-weight:500; letter-spacing:-0.03em; line-height:1.15; }
h1 { font-size:clamp(40px, 6vw, 68px); margin:0 0 12px; }
h2 { font-size:32px; margin:0 0 8px; }
.lede { font-size:20px; color:var(--muted); margin:0 0 22px; }
.actions { display:flex; gap:12px; flex-wrap:wrap; }
.btn, button.btn { display:inline-flex; align-items:center; justify-content:center; background:var(--green); color:var(--ink); text-decoration:none; border:0; border-radius:999px; padding:12px 18px; font:inherit; font-weight:700; cursor:pointer; }
.btn.secondary, button.btn.secondary { background:transparent; color:var(--text); border:1px solid var(--line); }
button.btn:disabled { opacity:0.45; cursor:not-allowed; }
.card .btn { margin-bottom:12px; }
.grid { display:grid; grid-template-columns:repeat(2, 1fr); gap:14px; margin:18px 0 42px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:18px; padding:18px 18px 8px; }
.card h3 { margin:0 0 6px; font-size:18px; }
.card p, .card li { color:var(--muted); }
section { margin:10px 0 42px; }
code, pre { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { background:#08110c; border:1px solid var(--line); border-radius:14px; padding:14px; overflow:auto; }
.note { color:var(--muted); }
footer { display:flex; gap:16px; flex-wrap:wrap; padding:28px 0 48px; color:var(--muted); }
footer a { overflow-wrap:anywhere; }
label { display:block; margin:12px 0; }
input { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:#0c140f; color:inherit; font:inherit; }
.error { color:#ffb4b4; }
@media (max-width: 760px) {
  header { align-items:flex-start; }
  .hero, .grid { grid-template-columns:1fr; }
  .hero img { width:min(200px, 100%); height:auto; }
}
</style>
</head>
<body>
<header>
  <a class="brand" href="/"><img src="/logo.jpg" alt=""> ${escapeHtml(SERVER_NAME)}</a>
  <nav>
    <a href="/connect">Connect</a>
    <a href="/account">Account</a>
    <a href="/privacy">Privacy</a>
    <a href="/support">Support</a>
    <a href="/health">Health</a>
  </nav>
</header>
<main>${body}</main>
<footer>
  <span>${escapeHtml(SERVER_NAME)}</span>
  <a href="/connect">MCP ${escapeHtml(mcp)}</a>
  <a href="/terms">Terms</a>
  <a href="/privacy">Privacy</a>
  <a href="/support">Support</a>
  <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>
  <a href="https://ouroborosapps.com">ouroborosapps.com</a>
  <a href="https://github.com/LAHutchins91/rank-mcp">Source</a>
</footer>
</body>
</html>`;
}

export function landingPage(config: AppConfig) {
  return page(config, SERVER_NAME, `
<section class="hero">
  <img src="/logo.jpg" width="280" height="280" alt="Rank logo: a green ouroboros around a rising bar chart">
  <div>
    <h1>${escapeHtml(SERVER_NAME)}</h1>
    <p class="lede">Ask your assistant what Search Console already knows: the queries, pages, clicks, impressions, CTR, and average position for the sites you verified.</p>
    <div class="actions">
      <a class="btn" href="/connect">Connect an assistant</a>
      <a class="btn secondary" href="/account">Connect Google</a>
    </div>
  </div>
</section>
<section>
  <h2>Built for people who own the site</h2>
  <div class="grid">
    <article class="card"><h3>Site owners</h3><p>See which queries already reach the homepage without opening another tab.</p></article>
    <article class="card"><h3>Bloggers</h3><p>Find posts that get seen and barely get clicked, using the CTR Search Console recorded.</p></article>
    <article class="card"><h3>Small businesses</h3><p>Compare this period with the one before it when a service page goes quiet.</p></article>
    <article class="card"><h3>SEO freelancers</h3><p>Read a client's verified property from the assistant you already work in.</p></article>
  </div>
</section>
<section>
  <h2>What the assistant can ask</h2>
  <div class="grid">
    <article class="card"><h3>Properties</h3><p>The verified Search Console properties on the Google account you connect.</p></article>
    <article class="card"><h3>Queries and pages</h3><p>Top queries and pages for a date range you choose.</p></article>
    <article class="card"><h3>Trends</h3><p>Daily clicks, impressions, CTR, and position, only on days the API returned.</p></article>
    <article class="card"><h3>Comparisons</h3><p>This range beside the previous one, with both totals from Search Console.</p></article>
    <article class="card"><h3>Quick wins</h3><p>Queries with lots of impressions and a low recorded CTR.</p></article>
    <article class="card"><h3>Drops and inspection</h3><p>Pages that lost clicks or position, plus URL Inspection status.</p></article>
  </div>
  <p class="note">Rank reports the numbers Search Console returned. It does not estimate traffic, invent rankings, or fill silent days with zeros. CTR stays the fraction the API sent.</p>
</section>
<section>
  <h2>14 days, then Pro</h2>
  <p>Connecting Google starts a 14-day trial. After that, Pro keeps the tools available. Monthly and yearly plans open in Stripe Checkout, which is where the amount is shown.</p>
  <a class="btn" href="/account">Open account</a>
  <p class="note">Privacy, deletion, and export requests go to <a href="mailto:${escapeHtml(supportEmail())}">${escapeHtml(supportEmail())}</a>.</p>
</section>`);
}

export function connectPage(config: AppConfig) {
  const mcp = `${config.appBaseUrl}/mcp`;
  const redirect = googleRedirectUri(config.appBaseUrl);
  const scopes = GOOGLE_SCOPES.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("");
  return page(config, `Connect ${SERVER_NAME}`, `
<section>
  <h1>Connect Rank</h1>
  <p class="lede">Add this MCP address in an assistant that supports Streamable HTTP and OAuth. Leave the client id and secret empty. Rank registers the client for you.</p>
  <pre>${escapeHtml(mcp)}</pre>
  <h2>Cursor</h2>
  <pre>${escapeHtml(JSON.stringify({ mcpServers: { rank: { url: mcp } } }, null, 2))}</pre>
  <h2>Claude Code</h2>
  <pre>claude mcp add --transport http rank ${escapeHtml(mcp)}</pre>
  <h2>ChatGPT, Claude, Gemini, and Grok</h2>
  <p>Add the same MCP address, choose OAuth, and approve the connection when the browser opens. Then connect the Google account that owns Search Console.</p>
  <h2>Google Cloud OAuth client</h2>
  <p>Create a <strong>Web application</strong> OAuth client. Set this authorized redirect URI exactly:</p>
  <pre>${escapeHtml(redirect)}</pre>
  <p>Add these consent-screen scopes:</p>
  <ul>${scopes}</ul>
  <p class="note">Put the client id and secret in <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>. The redirect URI changes only when <code>APP_BASE_URL</code> changes. For this server, <code>APP_BASE_URL</code> is <code>${escapeHtml(config.appBaseUrl)}</code>.</p>
</section>`);
}

export function privacyPage(config: AppConfig) {
  const email = supportEmail();
  const mailto = `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`;
  return page(config, "Privacy policy · Rank by Ouroboros Apps", `
<section>
  <h1>Privacy policy</h1>
  <p>Effective October 8, 2026. Rank by Ouroboros Apps is operated by Ouroboros Apps (Lawrence Hutchins). The product site is <a href="https://ouroborosapps.com">ouroborosapps.com</a>. Privacy, deletion, and export requests go to ${mailto}.</p>

  <h2>Information we process</h2>
  <p>Rank reads Google Search Console for the Google account you connect. The Google scope is read-only (<code>openid</code>, <code>https://www.googleapis.com/auth/userinfo.email</code>, and <code>https://www.googleapis.com/auth/webmasters.readonly</code>). Rank cannot change your site, submit sitemaps, or edit Search Console users.</p>
  <p>When you connect Google, Rank stores an account record: the Google account id (the OpenID subject), the email address Google returns, trial start and end, and subscription status. The Search Console refresh token is encrypted with AES-256-GCM before it is written. The encryption key stays in the server environment. Rank does not store the refresh token in plaintext.</p>
  <p>Google access tokens used to call Search Console are kept in memory for that server process and are not written to storage. Search Console responses (properties, queries, pages, clicks, impressions, CTR, position, and URL Inspection results) are not saved as a database of your reports. Rank returns the figures the API sent for the request you made and does not add estimated traffic.</p>
  <p>Connecting an assistant stores OAuth records for that connection: a registered client id and redirect URIs, a short-lived authorization code, and hashes of the MCP access token and refresh token. A signed browser cookie named <code>rank_session</code> keeps you signed in on this site. Pending Google and assistant sign-in records hold the redirect and PKCE challenge until you finish or the record expires.</p>
  <p>If you subscribe, Rank stores the Stripe customer id, subscription id, status, current period end, and whether the subscription cancels at period end. Stripe receives your account id and, until a customer exists, the email on the account. Rank does not store payment card numbers.</p>
  <p>Rank does not receive every assistant conversation. Tools receive only the arguments the assistant submits for that call. Do not include passwords, payment card details, or unrelated personal information in those arguments.</p>

  <h2>Why and where</h2>
  <p>We use this information to provide Rank, authenticate you, call Search Console on your behalf, tell whether the trial or Pro subscription is active, respond to support, prevent abuse, and meet legal obligations. We do not sell Search Console data or account data, and we do not use it to train our own models.</p>
  <p>Google provides sign-in and the Search Console API. Stripe processes subscription payments. Vercel hosts the service. The hosted server keeps account and OAuth records in a private Vercel Blob. A deployment set to the file or Postgres backend stores those same records in that file or database. Connected MCP clients, including ChatGPT, Claude, Gemini, Grok, Cursor, and other hosts you authorize, receive the Search Console results their authorized tools request and apply their own privacy terms. Service providers may process information outside your country. No advertising trackers are included.</p>

  <h2>Control and retention</h2>
  <p>Rank keeps each category for the period below. Where the software has no deletion job, the period is the policy we follow when you write to ${mailto}.</p>
  <h3>Account and OAuth identity</h3>
  <p>The Google account id, email, trial dates, and subscription status stay until you request account deletion. We delete that record within 30 days of the request. There is no shorter automatic schedule in the software.</p>
  <h3>Google Search Console tokens</h3>
  <p>The encrypted refresh token stays with the account record and is deleted with it, within 30 days of an account-deletion request. Google access tokens live only in process memory, follow the expiry Google returns (Rank treats a missing expiry as one hour), and are not reused in the last minute of that window. They are gone when they expire or when the process stops. They are not written to the store.</p>
  <h3>Cached and short-lived connection data</h3>
  <p>Search Console report bodies are not cached in Rank's store. Authorization codes and pending sign-in records last 10 minutes. MCP access-token hashes last 1 hour. MCP refresh-token hashes last 30 days, and the previous hash is deleted when a new refresh token is issued. Rank refuses these records after they expire. On the Vercel Blob store, each write also drops expired authorization codes, pending sign-in records, access tokens, and refresh tokens. The browser session cookie lasts 30 days. Registered MCP client records have no expiry in the software; we remove a client record within 30 days of a deletion request that identifies it.</p>
  <h3>Billing records</h3>
  <p>Rank's copies of the Stripe customer id, subscription id, and subscription status are deleted with the account, within 30 days of an account-deletion request. Stripe may keep its own payment records for accounting, tax, and dispute handling. Rank does not store complete card numbers. This site does not print a charge amount. Checkout is where the billing terms appear.</p>

  <h2>Deletion and export</h2>
  <p>Email ${mailto} to request a copy of your account or to delete it. Say whether you want export, deletion, or both, and include the Google email on the account. An export is the account record we hold: Google account id, email, trial and subscription status, and whether a Search Console refresh token is stored. We do not email the refresh token or payment card data. Deletion removes the live account record, the encrypted refresh token, and the MCP tokens stored for that account. Provider backups may persist according to the provider's own retention and are not an instant erasure guarantee. Disconnecting Google, canceling Stripe, and deleting the Rank account are separate steps.</p>

  <h2>Disconnect Google</h2>
  <p>Revoke Rank's access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. That stops Google from honoring the refresh token. Then email ${mailto} if you also want the encrypted token and account record deleted. Revoking access at Google does not by itself delete the stored record.</p>

  <h2>Children's privacy</h2>
  <p>Rank is not directed to children under 13, and we do not knowingly collect personal information from them. If you believe a child has connected an account, email ${mailto} and we will delete it.</p>

  <h2>Security and changes</h2>
  <p>Refresh tokens are encrypted before storage, the session cookie is HttpOnly, and MCP access and refresh tokens are stored as hashes. No service can promise absolute security. We publish changes to this policy on this page with an updated effective date. If local privacy law gives you additional rights, you may exercise them by emailing ${mailto}.</p>

  <h2>Contact</h2>
  <p>Rank by Ouroboros Apps. Site: <a href="https://ouroborosapps.com">ouroborosapps.com</a>. Privacy, support, deletion, and export: ${mailto}.</p>
</section>`);
}

export function termsPage(config: AppConfig) {
  return page(config, `Terms · ${SERVER_NAME}`, `
<section>
  <h1>Terms</h1>
  <p>Rank by Ouroboros Apps is published by Lawrence Hutchins. The product site is <a href="https://ouroborosapps.com">ouroborosapps.com</a>. Questions, privacy requests, deletion, and export go to <a href="mailto:${escapeHtml(supportEmail())}">${escapeHtml(supportEmail())}</a>. The <a href="/privacy">privacy policy</a> describes what Rank stores.</p>
  <p>The 14-day trial starts when you connect Google. After it ends, Search Console tools require a Pro subscription. Stripe Checkout shows the amount before you pay. You can cancel from the billing portal on the account page after a subscription exists. Canceling a subscription does not by itself delete the account.</p>
  <p>Search Console data belongs to the Google account that authorized it. You are responsible for connecting an account you are allowed to use. Rank reports API results and can be wrong when Search Console is still revising recent days.</p>
  <p>The software is provided under the MIT license, without warranty.</p>
</section>`);
}

export function accountPage(config: AppConfig, input: {
  email?: string;
  googleConnected?: boolean;
  trialEndsAt?: string;
  subscriptionStatus?: string;
  entitled?: boolean;
  billingReady: boolean;
  hasCustomer: boolean;
  notice?: string;
  error?: string;
}) {
  const status = input.email
    ? `<p>Signed in as <strong>${escapeHtml(input.email)}</strong>.</p>
       <p>Google Search Console: ${input.googleConnected ? "connected" : "not connected"}.</p>
       <p>Subscription status: ${escapeHtml(input.subscriptionStatus ?? "none")}.</p>
       <p>Trial ends: ${escapeHtml(input.trialEndsAt ?? "not started")}.</p>
       <p>${input.entitled ? "Search Console tools are available." : "Search Console tools are locked until you subscribe."}</p>`
    : `<p>Connect the Google account that owns your Search Console properties. That starts the 14-day trial.</p>
       <a class="btn" href="/google/start?return=/account">Connect Google</a>`;
  const plans = input.email ? `
    <div class="grid">
      <article class="card"><h3>Monthly</h3><p>Pro, billed each month. Stripe shows the amount at checkout.</p>
        <button class="btn checkout" data-plan="monthly" ${input.billingReady ? "" : "disabled"}>Start monthly</button></article>
      <article class="card"><h3>Yearly</h3><p>Pro, billed once a year. Stripe shows the amount at checkout.</p>
        <button class="btn checkout" data-plan="yearly" ${input.billingReady ? "" : "disabled"}>Start yearly</button></article>
    </div>
    ${input.billingReady ? "" : `<p class="note">Billing is not configured on this server yet.</p>`}
    ${input.hasCustomer ? `<button class="btn secondary" id="portal">Manage billing</button>` : ""}
    <p><a href="/google/start?return=/account">Reconnect Google</a></p>` : "";
  return page(config, `Account · ${SERVER_NAME}`, `
<section>
  <h1>Account</h1>
  ${input.notice ? `<p>${escapeHtml(input.notice)}</p>` : ""}
  ${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ""}
  ${status}
  ${plans}
</section>
<script>
async function post(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  location.href = data.url;
}
document.querySelectorAll(".checkout").forEach(function(button) {
  button.addEventListener("click", async function() {
    button.disabled = true;
    try { await post("/billing/checkout", { plan: button.getAttribute("data-plan") }); }
    catch (error) { alert(error.message); button.disabled = false; }
  });
});
var portal = document.getElementById("portal");
if (portal) portal.addEventListener("click", async function() {
  portal.disabled = true;
  try { await post("/billing/portal", {}); }
  catch (error) { alert(error.message); portal.disabled = false; }
});
</script>`, false);
}

export function consentPage(config: AppConfig, input: { clientName: string; redirectUri: string; authorizationId: string }) {
  return page(config, `Connect ${SERVER_NAME}`, `
<section>
  <h1>Connect ${escapeHtml(input.clientName)}?</h1>
  <p>This application will be able to read Search Console for the Google account you just connected, while your trial or Pro subscription is active.</p>
  <ul>
    <li>List verified properties.</li>
    <li>Read queries, pages, totals, and URL Inspection results you ask for.</li>
    <li>See whether your trial or subscription is active.</li>
  </ul>
  <p class="note">Return address: ${escapeHtml(input.redirectUri)}</p>
  <form method="post" action="/oauth/decision">
    <input type="hidden" name="authorization_id" value="${escapeHtml(input.authorizationId)}">
    <button class="btn" name="decision" value="approve">Connect</button>
    <button class="btn secondary" name="decision" value="deny">Cancel</button>
  </form>
</section>`, false);
}

export function messagePage(config: AppConfig, title: string, message: string) {
  return page(config, title, `<section><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/account">Back to account</a></p></section>`, false);
}

export function supportPage(config: AppConfig) {
  const email = supportEmail();
  return page(config, "Support · Rank by Ouroboros Apps", `
<section>
  <h1>Support</h1>
  <p>Rank by Ouroboros Apps. Questions about the product, billing, privacy, account deletion, or a copy of your account go to <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>. The site is <a href="https://ouroborosapps.com">ouroborosapps.com</a>.</p>
  <p>Include the Google email on the account, and say whether you want help, deletion, or an export. Do not include passwords, OAuth tokens, API keys, or payment card details.</p>
  <p>To disconnect Google Search Console, revoke Rank at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. The <a href="/privacy">privacy policy</a> describes what is stored and how long it is kept.</p>
  <p class="note">A new account gets a 14-day trial, then Pro. Checkout shows the billing terms.</p>
</section>`);
}

