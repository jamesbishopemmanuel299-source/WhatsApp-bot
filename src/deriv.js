import WebSocket from "ws";

const API = "https://api.derivws.com";

export class DerivClient {
  constructor({ token, appId, accountId }) {
    this.token = token;
    this.appId = appId;
    this.accountId = accountId;
    this.ws = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    const headers = { Authorization: `Bearer ${this.token}` };
    if (this.appId) headers["Deriv-App-ID"] = this.appId;
    const response = await fetch(`${API}/trading/v1/options/accounts/${encodeURIComponent(this.accountId)}/otp`, {
      method: "POST", headers
    });
    const body = await response.json();
    if (!response.ok || !body?.data?.url) {
      throw new Error(body?.errors?.[0]?.message || "Could not obtain Deriv WebSocket session");
    }

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(body.data.url);
      const timer = setTimeout(() => reject(new Error("Deriv connection timed out")), 15000);
      socket.once("open", () => {
        clearTimeout(timer);
        this.ws = socket;
        socket.on("message", raw => this.#onMessage(raw));
        socket.on("close", () => {
          this.ws = null;
          for (const [, item] of this.pending) item.reject(new Error("Deriv connection closed"));
          this.pending.clear();
        });
        socket.on("error", error => {
          for (const [, item] of this.pending) item.reject(error);
          this.pending.clear();
        });
        resolve();
      });
      socket.once("error", error => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  #onMessage(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const id = message.req_id;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message.error) pending.reject(new Error(message.error.message || message.error.code));
    else pending.resolve(message);
  }

  async request(payload) {
    await this.connect();
    const req_id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error("Deriv request timed out"));
      }, 20000);
      this.pending.set(req_id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
  }

  async balance() {
    const r = await this.request({ balance: 1 });
    return r.balance;
  }

  async candles(symbol, granularity = 60, count = 100) {
    const r = await this.request({
      ticks_history: symbol, end: "latest", count, style: "candles", granularity
    });
    return r.candles || [];
  }

  async buy({ symbol, contractType, stake, currency, duration = 5 }) {
    const proposal = await this.request({
      proposal: 1, amount: stake, basis: "stake", contract_type: contractType,
      currency, duration, duration_unit: "m", underlying_symbol: symbol
    });
    const p = proposal.proposal;
    if (!p?.id || !Number.isFinite(Number(p.ask_price))) throw new Error("Deriv returned an invalid proposal");
    const result = await this.request({ buy: p.id, price: Number(p.ask_price) });
    return result.buy;
  }

  async portfolio() {
    const r = await this.request({ portfolio: 1 });
    return r.portfolio?.contracts || [];
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}
