const SENDERS_URL = "https://messaging.twilio.com/v2/Channels/Senders";

export async function getWhatsAppSender({ accountSid, authToken }) {
  if (!accountSid || !authToken) throw new Error("Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to Render Environment.");
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) throw new Error("TWILIO_ACCOUNT_SID is not a valid Twilio Account SID format.");
  const credentials = Buffer.from(accountSid + ":" + authToken).toString("base64");
  const url = new URL(SENDERS_URL);
  url.searchParams.set("Channel", "whatsapp");
  url.searchParams.set("PageSize", "1000");
  const response = await fetch(url, { headers: { Authorization: "Basic " + credentials, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("Twilio rejected the credentials. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.");
    throw new Error("Twilio sender lookup failed: " + (data.message || data.detail || ("HTTP " + response.status)));
  }
  const senders = Array.isArray(data.senders) ? data.senders : [];
  if (!senders.length) return { found: false, online: false, senderId: null, phoneNumber: null, status: "NOT_FOUND" };
  const selected = senders.find(sender => sender.status === "ONLINE") || senders[0];
  const senderId = String(selected.sender_id || "");
  const phoneNumber = senderId.startsWith("whatsapp:") ? senderId.slice(9) : senderId;
  return { found: true, online: selected.status === "ONLINE", senderId, phoneNumber, status: String(selected.status || "UNKNOWN"), senderSid: selected.sid || null };
}
