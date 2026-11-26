import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import Database from "better-sqlite3";
import { DerivClient } from "./src/deriv.js";
import { buildSignal } from "./src/strategy.js";
import { reviewSignal } from "./src/ai.js";
import { getWhatsAppSender } from "./src/twilio-whatsapp.js";

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
const ownerChatId = String(env.OWNER_TELEGRAM_CHAT_ID || "").trim();
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
async function telegram(method, payload = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(35000)
  });
  const data = await response.json();
  if (!response.ok || data.ok !== true) throw new Error(data.description || `Telegram API error: ${response.status}`);
  return data.result;
}
async function sendTelegram(chatId, body) {
  return telegram("sendMessage", { chat_id: chatId, text: String(body).slice(0, 4000) });
}
function derivClient() {
  if (!env.DERIV_ACCESS_TOKEN || !env.DERIV_ACCOUNT_ID) throw new Error("Deriv is not configured. Add DERIV_ACCESS_TOKEN and DERIV_ACCOUNT_ID to the server environment.");
  return new DerivClient({
    token: env.DERIV_ACCESS_TOKEN,
    appId: env.DERIV_APP_ID,
    accountId: env.DERIV_ACCOUNT_ID,
    demoOnly: env.DEMO_ONLY !== "false",
    liveEnabled: env.ENABLE_LIVE_TRADING === "true"
  });
}
function formatSignal(s, symbol) {
  return `EMZARO TRADING AI
Market: ${symbol}
Signal: ${s.action}
Confidence: ${Math.round((s.confidence || 0) * 100)}%
RSI: ${s.rsi?.toFixed?.(1) ?? "n/a"}
Reason: ${s.reason}

Signals are not guarantees. Check the market and risk before trading.`;
}
async function scanAndMaybeTrade(allowTrade = false) {
  if (state.busy) return "A scan is already running. Please wait.";
  state.busy = true;
  let client;
  try {
    client = derivClient();
    await client.connect();
    const symbol = env.SYMBOL || "R_100";
    const candles = await client.candles(symbol, Number(env.CANDLE_GRANULARITY || 60), 100);
    const signal = buildSignal(candles);
    state.lastSignal = { ...signal, symbol, at: new Date().toISOString() };
    let message = formatSignal(signal, symbol);
    if (allowTrade && state.auto && signal.action !== "WAIT") {
      const ai = await reviewSignal(signal, env.GROQ_API_KEY, env.GROQ_MODEL || "llama-3.3-70b-versatile");
      if (!ai.approved) {
        message += `\n\nAI risk filter: SKIPPED — ${ai.reason}`;
      } else {
        const risk = riskRow();
        const stake = Number(env.DEFAULT_STAKE || 1);
        const maxStake = Number(env.MAX_STAKE || 2);
        const maxTrades = Number(env.MAX_TRADES_PER_DAY || 5);
        const dailyRisk = Number(env.MAX_DAILY_STAKE_RISK || 5);
        const maxOpen = Number(env.MAX_OPEN_TRADES || 1);
        if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is required before auto trading.");
        if (stake <= 0 || stake > maxStake) throw new Error("Configured stake exceeds MAX_STAKE.");
        if (risk.trades >= maxTrades || risk.stake_total + stake > dailyRisk) {
          state.auto = false;
          message += "\n\nAUTO PAUSED: daily trade or stake-risk limit reached.";
        } else if ((await client.portfolio()).length >= maxOpen) {
          message += "\n\nTrade skipped: maximum open positions reached.";
        } else {
          const balance = await client.balance();
          const currency = balance?.currency;
          if (!currency) throw new Error("Could not verify Deriv account currency.");
          const bought = await client.buy({ symbol, contractType: signal.action, stake, currency, duration: 5 });
          addRisk(stake);
          message += `\n\nDEMO/AUTHORIZED ORDER PLACED\nContract ID: ${bought.contract_id}\nStake: ${stake} ${currency}\nAI review: ${ai.reason}`;
        }
      }
    }
    return message;
  } finally {
    client?.close();
    state.busy = false;
  }
}

async function handleCommand(chatId, message) {
  const commandLine = message.trim();
  const [raw, ...rest] = commandLine.split(/\s+/);
  const command = (raw || "").toLowerCase();

  if (["/start", "/help", "hi", "hello", "hey", "menu"].includes(command)) {
    if (!ownerChatId) {
      return `EMZARO TRADING AI\nYour Telegram chat ID is: ${chatId}\n\nAdd this number as OWNER_TELEGRAM_CHAT_ID in your Render Environment, then restart the service. Do not share your bot token.`;
    }
    if (String(chatId) !== ownerChatId) return "This trading bot is private. Your chat is not authorized.";
    return "EMZARO TRADING AI\n\n/status — bot status\n/whatsapp — detect your registered Twilio WhatsApp number\n/balance — Deriv balance\n/signal — get a market signal\n/auto on — enable demo auto trading\n/auto off — stop auto trading\n/positions — open positions\n\nAuto trading is OFF by default. Live trading is blocked unless separately enabled on the server.";
  }

  if (!ownerChatId) return `Setup incomplete. Your Telegram chat ID is ${chatId}. Add it as OWNER_TELEGRAM_CHAT_ID in Render Environment.`;
  if (String(chatId) !== ownerChatId) return "This trading bot is private. Your chat is not authorized.";

  if (command === "/whatsapp") {
    const sender = await getWhatsAppSender({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN });
    if (!sender.found) return "No WhatsApp sender is registered on this Twilio account yet. Register your permanent WhatsApp Business number in Twilio, then try /whatsapp again.";
    return "TWILIO WHATSAPP SENDER\nNumber: " + sender.phoneNumber + "\nStatus: " + sender.status + "\nAvailable: " + (sender.online ? "YES" : "NOT ONLINE YET") + "\n\nThe number is read directly from Twilio; it is not hardcoded in this app."; 
  }

  if (command === "/status") {
    return `Bot: ONLINE\nAuto trading: ${state.auto ? "ON" : "OFF"}\nMode: ${env.DEMO_ONLY !== "false" ? "DEMO ONLY" : (env.ENABLE_LIVE_TRADING === "true" ? "LIVE PERMITTED BY SERVER CONFIG" : "LIVE BLOCKED")}\nDaily stake total: ${riskRow().stake_total}/${Number(env.MAX_DAILY_STAKE_RISK || 5)}\nTrades today: ${riskRow().trades}`;
  }
  if (command === "/signal") return scanAndMaybeTrade(false);
  if (command === "/auto") {
    const action = (rest[0] || "").toLowerCase();
    if (action === "off" || action === "stop") { state.auto = false; return "Automatic trading stopped."; }
    if (action === "on") {
      if (!env.GROQ_API_KEY) return "Add GROQ_API_KEY to Render before enabling AI-reviewed auto trading.";
      if (!env.DERIV_ACCESS_TOKEN || !env.DERIV_ACCOUNT_ID) return "Connect Deriv first by adding the required server credentials.";
      if (env.DEMO_ONLY === "false" && env.ENABLE_LIVE_TRADING !== "true") return "Live trading is blocked. Enable it deliberately in server environment only after demo testing.";
      state.auto = true;
      return "Auto trading enabled. Scheduled AI-reviewed scans are active. Send /auto off to stop. Trading can lose money.";
    }
    return "Use /auto on or /auto off.";
  }
  if (command === "/balance") {
    const client = derivClient();
    try { const b = await client.balance(); return `Deriv balance: ${b.balance} ${b.currency}`; }
    finally { client.close(); }
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

app.get("/whatsapp", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>WhatsApp Number Lookup</title><style>body{font-family:system-ui;background:#101714;color:#eef8f1;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}.card{max-width:440px;width:100%;background:#1b2821;border:1px solid #385343;border-radius:18px;padding:26px;box-sizing:border-box}h1{font-size:24px}p{color:#b8c9be;line-height:1.5}input,button{width:100%;box-sizing:border-box;padding:14px;border-radius:10px;font-size:16px;margin-top:12px}input{background:#101714;color:white;border:1px solid #52695a}button{background:#25c46a;color:#062412;border:0;font-weight:700;cursor:pointer}.result{margin-top:18px;padding:14px;background:#101714;border-radius:10px;overflow-wrap:anywhere}.number{font-size:24px;font-weight:700}.muted{font-size:13px;color:#9eb0a4}</style></head><body><main class=\"card\"><h1>Your WhatsApp Business number</h1><p>Enter the private lookup key saved in your Render environment. Your Twilio credentials remain on the server.</p><form id=\"lookup\"><label for=\"key\">Private lookup key</label><input id=\"key\" name=\"key\" type=\"password\" autocomplete=\"current-password\" required><button type=\"submit\">Find my WhatsApp number</button></form><div id=\"result\" class=\"result\" hidden></div><p class=\"muted\">This only finds a sender already registered in your Twilio account. It does not register a new number.</p></main><script>const form=document.getElementById(\"lookup\"),result=document.getElementById(\"result\");form.addEventListener(\"submit\",async e=>{e.preventDefault();result.hidden=false;result.textContent=\"Checking Twilio…\";try{const response=await fetch(\"/whatsapp/lookup\",{method:\"POST\",headers:{\"Content-Type\":\"application/x-www-form-urlencoded\"},body:new URLSearchParams({key:document.getElementById(\"key\").value})});const data=await response.json();if(!response.ok)throw new Error(data.error||\"Lookup failed\");result.innerHTML=\"\";const number=document.createElement(\"div\");number.className=\"number\";number.textContent=data.phoneNumber;const status=document.createElement(\"div\");status.textContent=\"Status: \"+data.status;result.append(number,status)}catch(error){result.textContent=error.message}});</script></body></html>");
});

const lookupAttempts = new Map();
app.post("/whatsapp/lookup", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
  res.set("Cache-Control", "no-store");
  const configuredKey = String(env.WHATSAPP_LOOKUP_KEY || "");
  const suppliedKey = String(req.body?.key || "");
  if (!configuredKey) return res.status(503).json({ error: "Set WHATSAPP_LOOKUP_KEY in Render Environment, then redeploy." });
  const now = Date.now();
  const ip = String(req.ip || "unknown");
  const attempts = lookupAttempts.get(ip) || { count: 0, resetAt: now + 300000 };
  if (now > attempts.resetAt) { attempts.count = 0; attempts.resetAt = now + 300000; }
  if (attempts.count >= 10) return res.status(429).json({ error: "Too many attempts. Wait five minutes and try again." });
  attempts.count += 1; lookupAttempts.set(ip, attempts);
  const a = Buffer.from(configuredKey); const b = Buffer.from(suppliedKey);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: "Incorrect lookup key." });
  try {
    const sender = await getWhatsAppSender({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN });
    if (!sender.found) return res.status(404).json({ error: "No WhatsApp sender is registered on this Twilio account." });
    return res.json({ phoneNumber: sender.phoneNumber, status: sender.status, online: sender.online });
  } catch (error) {
    console.error("WhatsApp sender lookup failed:", error.message);
    return res.status(502).json({ error: "Could not read the WhatsApp number from Twilio. Check the Twilio credentials in Render." });
  }
});
app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "emzaro-deriv-telegram-bot",
  telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
  ownerConfigured: Boolean(ownerChatId),
  twilioConfigured: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
  whatsappLookupConfigured: Boolean(env.WHATSAPP_LOOKUP_KEY),
  auto: state.auto
}));

async function pollTelegram() {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.log("TELEGRAM_BOT_TOKEN missing; Telegram polling is disabled.");
    return;
  }
  let offset = 0;
  try {
    await telegram("deleteWebhook", { drop_pending_updates: false });
  } catch (error) {
    console.error("Could not clear an existing Telegram webhook:", error.message);
  }
  console.log("Telegram long polling started.");
  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset, timeout: 25, allowed_updates: ["message"]
      });
      for (const update of updates || []) {
        offset = Math.max(offset, update.update_id + 1);
        const message = update.message;
        if (!message?.text || !message.chat?.id || message.chat.type !== "private") continue;
        const chatId = String(message.chat.id);
        try {
          const reply = await handleCommand(chatId, message.text);
          await sendTelegram(chatId, reply);
        } catch (error) {
          console.error("Telegram command failed:", error.message);
          try { await sendTelegram(chatId, `Bot error: ${error.message}`); } catch (sendError) {
            console.error("Could not send Telegram error:", sendError.message);
          }
        }
      }
    } catch (error) {
      console.error("Telegram polling error:", error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

const intervalMs = Math.max(30, Number(env.SCAN_INTERVAL_SECONDS || 60)) * 1000;
setInterval(async () => {
  if (!state.auto || state.busy || !ownerChatId) return;
  try {
    const message = await scanAndMaybeTrade(true);
    await sendTelegram(ownerChatId, message);
  } catch (error) {
    console.error("Auto scan failed:", error.message);
    try { await sendTelegram(ownerChatId, `Auto scan error: ${error.message}. Auto trading has been paused.`); } catch {}
    state.auto = false;
  }
}, intervalMs);

app.listen(port, () => {
  console.log(`EMZARO Trading AI Telegram service listening on ${port}`);
  void pollTelegram();
});
