# EMZARO Trading AI — WhatsApp + Deriv

A private WhatsApp command bot for Deriv. It receives WhatsApp Cloud API webhooks, analyses Deriv candle data with EMA(9)/EMA(21) and RSI(14), asks Groq to act as a second risk filter, and can place a small-stake options contract when auto mode is enabled.

## Safety defaults

- Automatic trading is OFF on startup.
- `DEMO_ONLY=true` is the default. Use a Deriv demo account first.
- Live trading is blocked unless the server is deliberately configured with `DEMO_ONLY=false` and `ENABLE_LIVE_TRADING=true`.
- Only the configured `OWNER_WHATSAPP_NUMBER` can issue commands.
- Stake, daily stake-at-risk, trade count, and open-position limits are checked before each automated order.
- AI output is a filter, not a guarantee or a source of market truth.

This is experimental software, not financial advice. Trading can lose the full stake. Test in demo and inspect the code before enabling any live account.

## Deploy on Render

1. Create a **Web Service** from this repository.
2. Runtime: Node; Build command: `npm install`; Start command: `npm start`.
3. Add environment variables from `.env.example` in Render. Do not commit `.env` or paste API keys into WhatsApp.
4. Add a persistent disk mounted at `/opt/render/project/src/data` and set `DB_PATH=/opt/render/project/src/data/bot.db` if you want daily counters to survive restarts.
5. Set the Meta webhook URL to `https://YOUR-SERVICE.onrender.com/webhook`, subscribe to the `messages` webhook field, and use the same `WHATSAPP_VERIFY_TOKEN`.
6. Set `WHATSAPP_APP_SECRET` to validate webhook signatures.

## Required credentials

- Meta WhatsApp Cloud API: access token and phone number ID.
- Groq: API key.
- Deriv: trade-scoped Personal Access Token (PAT), account ID, and App ID for PAT authentication.

Deriv uses its current OTP flow: the server requests a short-lived authenticated WebSocket URL from `POST /trading/v1/options/accounts/{accountId}/otp`, then connects directly to that URL. Never expose the Deriv token to the browser or chat.

## WhatsApp commands

- `/help`
- `/status`
- `/balance`
- `/signal` — technical signal only; does not place a trade.
- `/auto on` — enables scheduled AI-reviewed demo trading.
- `/auto off` — stops new automated trades.
- `/positions`

## Current strategy

The sample strategy looks for an EMA 9 / EMA 21 crossover on the configured Deriv symbol and checks RSI(14). Groq reviews the structured signal and may reject it. No strategy guarantees profit. The bot does not promise exact entry/stop-loss/take-profit levels; this initial options implementation uses a 5-minute CALL/PUT contract and a defined stake.

## Health check

Visit `/health`. A healthy service returns JSON with `ok: true`.

## Important implementation notes

- This initial version uses a single owner number and in-memory auto-mode state. Auto mode resets to OFF after a server restart.
- Daily stake counters use SQLite. Configure a persistent Render disk if counters must survive restarts.
- Confirm the configured Deriv account is a demo account while `DEMO_ONLY=true`. The application validates the authenticated WebSocket endpoint before any trade.
