import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { DerivClient } from "./src/deriv.js";
import { buildSignal } from "./src/strategy.js";
import { reviewSignal } from "./src/ai.js";

const app = express();
const db = new Database(process.env.DB_PATH || "bot.db");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_risk (
    day TEXT PRIMARY KEY,
    trades INTEGER NOT NULL DEFAULT 0,
    stake_total REAL NOT NULL DEFAULT 0
  );
`);

const env = process.env;
const owner = (env.OWNER_WHATSAPP_NUMBER || "").replace(/\D/g, "");
const state = { auto: false, busy: false, lastSignal: null };
const port = Number(env.PORT || 3000);

function today() { return new Date().toISOString().slice(0, 10); }
function riskRow() {
  return db.prepare("SELECT * FROM daily_risk WHERE day = ?").get(today()) || { trades: 0, stake_total: 0 };
}
function addRisk(stake) {
  db.prepare(`INSERT INTO daily_risk(day,trades,stake_total) VALUES(?,1,?)
    ON CONFLICT(day) DO UPDATE SET trades=trades+1, stake_total=stake_total+excluded.stake_total`)
    .run(today(), stake);
}
function verifyMeta(req) {
  if (!env.WHATSAPP_APP_SECRET) return true;
  const signature = req.get("x-hub-signature-256") || "";
  const expected = "sha256=" + crypto.createHmac("sha256", env.WHATSAPP_APP_SECRET).update(req.body).digest("hex");
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
async function sendWhatsApp(to, body) {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log("WhatsApp credentials missing; outgoing message suppressed.");
    return;
  }
  const version = env.WHATSAPP_API_VERSION || "v23.0";
  const response = await fetch(`https://graph.facebook.com/${version}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to,
      type: "text", text: { preview_url: false, body: String(body).slice(0, 4000) }
    })
  });
  if (!response.ok) throw new Error(`WhatsApp send failed: ${response.status} ${await response.text()}`);
}
function derivClient() {
  if (!env.DERIV_ACCESS_TOKEN || !env.DERIV_ACCOUNT_ID) throw new Error("Deriv is not configured. Add DERIV_ACCESS_TOKEN and DERIV_ACCOUNT_ID to server environment.");
  return new DerivClient({ token: env.DERIV_ACCESS_TOKEN, appId: env.DERIV_APP_ID, accountId: env.DERIV_ACCOUNT_ID });
}
function formatSignal(s, symbol) {
  return `EMZARO TRADING AI\nMarket: ${symbol}\nSignal: ${s.action}\nConfidence: ${Math.round((s.confidence || 0) * 100)}%\nRSI: ${s.rsi?.toFixed?.(1) ?? "n/a"}\nReason: ${s.reason}\n\nSignals are not guarantees. Check the market and risk before trading.`;
}
async function scanAndMaybeTrade(to, allowTrade = false) {
  if (state.busy) return "A scan is already running. Please wait.";
  state.busy = true;
  const client = derivClient();
  try {
    await client.connect();
    const symbol = env.SYMBOL || "R_100";
    const candles = await client.candles(symbol, Number(env.CANDLE_GRANULARITY || 60), 100);
    const signal = buildSignal(candles);
    state.lastSignal = { ...signal, symbol, at: new Date().toISOString() };
    let text = formatSignal(signal, symbol);
    if (allowTrade && state.auto && signal.action !== "WAIT") {
      const ai = await reviewSignal(signal, env.GROQ_API_KEY, env.GROQ_MODEL || "llama-3.3-70b-versatile");
      if (!ai.approved) {
        text += `\n\nAI risk filter: SKIPPED — ${ai.reason}`;
      } else {
        const risk = riskRow();
        const stake = Number(env.DEFAULT_STAKE || 1);
        const maxStake = Number(env.MAX_STAKE || 2);
        const maxTrades = Number(env.MAX_TRADES_PER_DAY || 5);
        const dailyRisk = Number(env.MAX_DAILY_LOSS || 5);
        const maxOpen = Number(env.MAX_OPEN_TRADES || 1);
        if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is required before auto trading.");
        if (stake <= 0 || stake > maxStake) throw new Error("Configured stake exceeds MAX_STAKE.");
        if (risk.trades >= maxTrades || risk.stake_total + stake > dailyRisk) {
          state.auto = false;
          text += "\n\nAUTO PAUSED: daily trade or stake-risk limit reached.";
        } else if ((await client.portfolio()).length >= maxOpen) {
          text += "\n\nTrade skipped: maximum open positions reached.";
        } else {
          const bal = await client.balance();
          const currency = bal?.currency;
          if (!currency) throw new Error("Could not verify Deriv account currency.");
          const bought = await client.buy({
            symbol, contractType: signal.action, stake, currency, duration: 5
          });
          addRisk(stake);
          text += `\n\nDEMO/AUTHORIZED ORDER PLACED\nContract ID: ${bought.contract_id}\nStake: ${stake} ${currency}\nAI review: ${ai.reason}`;
        }
      }
    }
    return text;
  } finally {
    client.close();
    state.busy = false;
  }
}

async function handleCommand(from, message) {
  if (owner && from !== owner) return "This trading bot is private. Your number is not authorized.";
  const [raw, ...rest] = message.trim().split(/\s+/);
  const command = (raw || "").toLowerCase();
  if (["hi", "hello", "hey", "start", "/start", "/help", "menu"].includes(command)) {
    return "EMZARO TRADING AI\n\n/status — bot status\n/balance — Deriv balance\n/signal — get a market signal\n/auto on — enable demo auto trading\n/auto off — stop auto trading\n/positions — open positions\n\nAuto trading is OFF by default. Live trading is blocked unless separately enabled on the server.";
  }
  if (command === "/status") {
    return `Bot: ONLINE\nAuto trading: ${state.auto ? "ON" : "OFF"}\nMode: ${env.DEMO_ONLY !== "false" ? "DEMO ONLY" : (env.ENABLE_LIVE_TRADING === "true" ? "LIVE PERMITTED BY SERVER CONFIG" : "LIVE BLOCKED")}\nDaily risk: ${riskRow().stake_total}/${Number(env.MAX_DAILY_LOSS || 5)}\nTrades today: ${riskRow().trades}`;
  }
  if (command === "/signal") return scanAndMaybeTrade(from, false);
  if (command === "/auto") {
    const action = (rest[0] || "").toLowerCase();
    if (action === "off" || action === "stop") { state.auto = false; return "Automatic trading stopped."; }
    if (action === "on") {
      if (!env.GROQ_API_KEY) return "Add GROQ_API_KEY to the server before enabling AI-reviewed auto trading.";
      if (!env.DERIV_ACCESS_TOKEN || !env.DERIV_ACCOUNT_ID) return "Connect Deriv first by adding the required server credentials.";
      if (env.DEMO_ONLY === "false" && env.ENABLE_LIVE_TRADING !== "true") return "Live trading is blocked. Enable it deliberately in server environment only after demo testing.";
      state.auto = true;
      return "Auto trading enabled. The bot will scan on its schedule. Send /auto off to stop. Trading can lose money.";
    }
    return "Use /auto on or /auto off.";
  }
  if (command === "/balance") {
    const client = derivClient();
    try {
      const b = await client.balance();
      return `Deriv balance: ${b.balance} ${b.currency}`;
    } finally { client.close(); }
  }
  if (command === "/positions") {
    const client = derivClient();
    try {
      const positions = await client.portfolio();
      return positions.length ? positions.map(p => `#${p.contract_id} ${p.contract_type} ${p.underlying_symbol || ""} — ${p.buy_price}`).join("\n") : "No open positions.";
    } finally { client.close(); }
  }
  return "Unknown command. Send /help to see available commands.";
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "emzaro-deriv-whatsapp-bot", auto: state.auto }));
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && token === env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!verifyMeta(req)) return res.sendStatus(401);
  let payload;
  try { payload = JSON.parse(req.body.toString("utf8")); } catch { return res.sendStatus(400); }
  res.sendStatus(200);
  try {
    const value = payload.entry?.[0]?.changes?.[0]?.value;
    for (const item of value?.messages || []) {
      if (item.type !== "text") continue;
      const from = (item.from || "").replace(/\D/g, "");
      const text = item.text?.body || "";
      try {
        const reply = await handleCommand(from, text);
        await sendWhatsApp(from, reply);
      } catch (error) {
        console.error("Command failed:", error.message);
        await sendWhatsApp(from, `Bot error: ${error.message}`);
      }
    }
  } catch (error) { console.error("Webhook processing failed:", error.message); }
});

const intervalMs = Math.max(30, Number(env.SCAN_INTERVAL_SECONDS || 60)) * 1000;
setInterval(async () => {
  if (!state.auto || state.busy || !owner) return;
  try {
    const message = await scanAndMaybeTrade(owner, true);
    await sendWhatsApp(owner, message);
  } catch (error) {
    console.error("Auto scan failed:", error.message);
    await sendWhatsApp(owner, `Auto scan error: ${error.message}. Auto trading has been paused.`);
    state.auto = false;
  }
}, intervalMs);

app.listen(port, () => console.log(`EMZARO Trading AI listening on ${port}`));
