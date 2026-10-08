# Rank by Ouroboros

Rank by Ouroboros answers SEO questions from the Google Search Console account you connect. It is for site owners, bloggers, small businesses, and SEO freelancers who want those numbers inside ChatGPT, Claude, Gemini, Grok, Cursor, or any other MCP client that speaks Streamable HTTP and OAuth.

The assistant can list verified properties, read top queries and pages, follow clicks, impressions, CTR, and average position over time, compare two periods, find queries with high impressions and low CTR, see pages that dropped, and check URL Inspection status. Every metric comes from the Search Console API response. Rank does not estimate traffic or fill in days the API left out. CTR stays the fraction Search Console returned (0.02 is 2%).

A 14-day trial starts when you connect Google. After that, Pro is a Stripe subscription. The amount is shown at Stripe Checkout, not in this README or the product.

## Hosted server

- MCP server URL: `https://rank.ouroborosapps.com/mcp` (Streamable HTTP, OAuth sign-in)
- Docs: https://ouroborosapps.com/docs/rank
- Status: early access. Paste the URL into Claude, Cursor, Grok, or ChatGPT developer mode.
- Registry name: `io.github.LAHutchins91/rank`

## Connect an assistant

The MCP address is `https://YOUR_HOST/mcp` after deploy, or `http://127.0.0.1:44721/mcp` when you run it locally. Choose OAuth and leave the client id and secret empty. Rank supports dynamic client registration and PKCE.

Cursor, in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "rank": {
      "url": "http://127.0.0.1:44721/mcp"
    }
  }
}
```

Claude Code:

```bash
claude mcp add --transport http rank http://127.0.0.1:44721/mcp
```

Use the same URL for ChatGPT, Claude, Gemini, and Grok. The in-app connect page repeats these steps for the host in `APP_BASE_URL`.

## Tools

- `list_properties` — verified Search Console properties
- `top_queries` — queries for a date range
- `top_pages` — pages for a date range
- `performance_trends` — daily clicks, impressions, CTR, and position
- `compare_periods` — totals for two ranges, plus differences labeled as derived from those totals
- `quick_wins` — queries at or above an impression threshold and at or below a CTR threshold
- `dropped_pages` — pages whose position worsened, whose clicks fell, or that disappeared from the current response
- `inspect_url` — URL Inspection API result
- `account_status` — whether Google is connected and whether the trial or Pro subscription is active

If you omit dates, Rank uses a 28-day window ending three UTC days ago and says so in the result. Pass `startDate` and `endDate` (`YYYY-MM-DD`) to choose the window.

## Google Cloud OAuth client

Create an OAuth client of type **Web application**. Rank reads:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Authorized redirect URI, exactly, with no trailing slash on the origin:

```text
${APP_BASE_URL}/google/callback
```

Locally, with the default `APP_BASE_URL`, that is:

```text
http://127.0.0.1:44721/google/callback
```

Add these scopes on the OAuth consent screen:

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/webmasters.readonly`

`webmasters.readonly` is the Search Console read-only scope. Rank requests offline access so Google returns a refresh token. The refresh token is encrypted before it is stored. `TOKEN_ENCRYPTION_KEY` is the key (a long random string). If the key changes, existing tokens cannot be read and the account has to connect Google again.

If the Google console asks for an authorized JavaScript origin, use the origin of `APP_BASE_URL` (`http://127.0.0.1:44721` locally). The redirect URI above is the value that must match.

## Storage

Trial state, Stripe customer ids, MCP OAuth clients and tokens, pending Google sign-in, and the encrypted Google refresh token share one storage interface. Set `STORAGE_BACKEND`:

| Backend | When | What it uses |
| --- | --- | --- |
| `memory` | local experiments and tests | data disappears when the process stops |
| `file` | a single long-running server or Docker volume | `STORAGE_FILE` (default `./data/rank-store.json`) |
| `blob` | Vercel | one private Blob at `STORAGE_BLOB_PATH` (default `rank/store.json`) |
| `postgres` | a Postgres database you already run | `DATABASE_URL` |

Postgres uses one table, created on first use if it is missing:

```sql
CREATE TABLE IF NOT EXISTS rank_kv (
  collection text NOT NULL,
  id text NOT NULL,
  document jsonb NOT NULL,
  PRIMARY KEY (collection, id)
);
```

There is no second schema. Memory and file storage reset on Vercel, so production uses the Blob backend. The Blob document uses the same layout as the file store: collections of JSON records. OAuth authorization codes and pending Google sign-in state are records in that document, so a callback can land on a different serverless instance. Each write drops expired auth codes, pending sign-in sessions, access tokens, and refresh tokens. `BLOB_READ_WRITE_TOKEN` is injected when the Vercel Blob store is connected. Do not commit it.

## Billing

Set these from the Stripe account Lawrence already uses. Do not create products in this repo. The price ids are not dollar amounts.

- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_MONTHLY`
- `STRIPE_PRICE_YEARLY`
- `STRIPE_WEBHOOK_SECRET`

Checkout is `POST /billing/checkout` with `{ "plan": "monthly" }` or `{ "plan": "yearly" }`. The webhook is `POST /billing/webhook`. `GET /health` includes `billingConfigured: true` only when the secret key and both price ids are set.

The local trial is 14 days from the first Google connection. Checkout sends Stripe the whole days still left in that trial, when any remain, so the first charge waits until the trial is over.

## Run locally

```bash
npm install
cp .env.example .env
# fill Google, encryption, and Stripe values in .env
npm run dev
```

The server listens on `PORT` (default `44721`).

```bash
npm test
npm run typecheck
npm start
```

`npm start` runs the compiled server. Docker builds the same command (`node dist/src/server.js`) and expects `logo.jpg` at the image root.

## Deploy

Vercel: set `APP_BASE_URL` to `https://rank.ouroborosapps.com`, set `STORAGE_BACKEND=blob`, and connect a Blob store so Vercel injects `BLOB_READ_WRITE_TOKEN`. `vercel.json` sends every path to the Node function and bundles `logo.jpg` into that function. `/logo.jpg` and the app routes are served by the function. `/package.json` is not a static file. The remote in `server.json` is `https://rank.ouroborosapps.com/mcp`.

The registry name is `io.github.LAHutchins91/rank`. The icon is `https://rank.ouroborosapps.com/logo.jpg`.

## Environment variables

| Variable | Required for |
| --- | --- |
| `APP_BASE_URL` | public origin; determines the Google redirect URI |
| `PORT` | listen port, default `44721` |
| `GOOGLE_CLIENT_ID` | Google sign-in and Search Console |
| `GOOGLE_CLIENT_SECRET` | Google token exchange |
| `TOKEN_ENCRYPTION_KEY` | encrypting refresh tokens and signing the browser session |
| `STORAGE_BACKEND` | `memory`, `file`, `blob`, or `postgres` |
| `STORAGE_FILE` | file backend path |
| `STORAGE_BLOB_PATH` | blob pathname, default `rank/store.json` |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob read-write token, injected on Vercel |
| `DATABASE_URL` | postgres backend |
| `STRIPE_SECRET_KEY` | Checkout and the billing portal |
| `STRIPE_PRICE_MONTHLY` | monthly Checkout price id |
| `STRIPE_PRICE_YEARLY` | yearly Checkout price id |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signatures |

`RANK_TEST_HOOKS=1` lets tests complete MCP login without Google. The process refuses to start when that is set and `NODE_ENV=production`.

## License

MIT. Copyright (c) 2026 Lawrence Hutchins.

---

More from Ouroboros: https://ouroborosapps.com
