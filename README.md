# EMZARO Trading AI — Telegram + Deriv

A private Telegram command bot for Deriv. It receives Telegram messages using the official Bot API long-polling method, analyses Deriv candle data with EMA(9)/EMA(21) and RSI(14), asks Groq to act as a second risk filter, and can place a small-stake options contract when auto mode is enabled.

## Safety defaults

- Automatic trading is OFF on startup.
- `DEMO_ONLY=true` is the default. Use a Deriv demo account first.
- Live trading is blocked unless the server is deliberately configured with `DEMO_ONLY=false` and `ENABLE_LIVE_TRADING=true`.
- Only the configured `OWNER_TELEGRAM_CHAT_ID` can issue trading commands.
- Stake, daily stake-at-risk, trade count, and open-position limits are checked before each automated order.
- AI output is a filter, not a guarantee or a source of market truth.

This is experimental software, not financial advice. Trading can lose the full stake. Test in demo and inspect the code before enabling any live account.

## Create your Telegram bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, choose a display name and a username ending in `bot`.
3. Copy the bot token into Render as `TELEGRAM_BOT_TOKEN`. Never commit or share it.
4. Deploy the service and open the bot chat. Send `/start`.
5. The bot replies with your numeric chat ID. Add that value to Render as `OWNER_TELEGRAM_CHAT_ID`, then redeploy/restart.
6. Send `/help` to confirm the private command menu appears.

The app uses Telegram long polling, so no Meta account, webhook URL, or Telegram webhook configuration is required. Do not run multiple service instances with the same bot token.

## Deploy on Render

1. Create or update a **Web Service** from this repository.
2. Runtime: Node; Build command: `npm install`; Start command: `npm start`.
3. Add the environment variables below in Render. Do not commit `.env` or paste API keys into Telegram.
4. Add a persistent disk mounted at `/opt/render/project/src/data` and set `DB_PATH=/opt/render/project/src/data/bot.db` if you want daily counters to survive restarts.
5. Check `https://YOUR-SERVICE.onrender.com/health`. It reports whether Telegram and owner configuration are present.

## Twilio WhatsApp sender discovery

Add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and a strong private `WHATSAPP_LOOKUP_KEY` to Render Environment. Open `/whatsapp` on your service, enter the lookup key, and the page securely requests the registered sender number from the server. The private Telegram owner command `/whatsapp` queries the Twilio WhatsApp Senders API and returns the registered sender number and status. It prefers a sender with status `ONLINE`. Credentials stay server-side and are never returned by `/health`. This discovers an already registered sender; it does not purchase, register, or verify a number.

## Required credentials

- Twilio WhatsApp discovery: `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
- Telegram: `TELEGRAM_BOT_TOKEN` and `OWNER_TELEGRAM_CHAT_ID`.
- Groq: `GROQ_API_KEY`.
- Deriv: trade-scoped Personal Access Token, account ID, and App ID for PAT authentication.

Deriv uses its current OTP flow: the server requests a short-lived authenticated WebSocket URL from `POST /trading/v1/options/accounts/{accountId}/otp`, then connects directly to that URL. Never expose the Deriv token to the browser or chat.

## Telegram commands

- `/start` or `/help`
- `/status`
- `/balance`
- `/signal` — technical signal only; does not place a trade.
- `/auto on` — enables scheduled AI-reviewed demo trading.
- `/auto off` — stops new automated trades.
- `/positions`

## Current strategy

The sample strategy looks for an EMA 9 / EMA 21 crossover and checks RSI(14). Groq reviews the structured signal and may reject it. No strategy guarantees profit. This initial options implementation uses a 5-minute CALL/PUT contract and a defined stake.

## Health check

Visit `/health`. A healthy service returns JSON with `ok: true`.

## Important implementation notes

- This initial version uses a single owner chat ID and in-memory auto-mode state. Auto mode resets to OFF after a server restart.
- Daily stake counters use SQLite. Configure a persistent Render disk if counters must survive restarts.
- Keep `DEMO_ONLY=true` until you have tested the bot carefully on a Deriv demo account.
