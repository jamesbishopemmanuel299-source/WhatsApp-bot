const SENDERS_URL = "https://messaging.twilio.com/v2/Channels/Senders";

/**
 * Reads WhatsApp senders registered on this Twilio account.
 * Use the Account SID and Auth Token from the same Twilio account/subaccount.
 */
export async function getWhatsAppSender({ accountSid, authToken }) {
  const sid = String(accountSid || "").trim();
  const token = String(authToken || "").trim();

  if (!sid || !token) {
    throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in Render Environment.");
  }
  if (!/^AC[0-9a-f]{32}$/i.test(sid)) {
    throw new Error("TWILIO_ACCOUNT_SID must be your Twilio Account SID beginning with AC (not an API Key SID beginning with SK).");
  }

  const credentials = Buffer.from(sid + ":" + token).toString("base64");
  const url = new URL(SENDERS_URL);
  url.searchParams.set("Channel", "whatsapp");
  url.searchParams.set("PageSize", "1000");

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: "Basic " + credentials,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw new Error("Could not connect to Twilio: " + (error.name === "TimeoutError" ? "request timed out" : "network connection failed") + ".");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data.code ? " (Twilio code " + data.code + ")" : "";
    if (response.status === 401) {
      throw new Error("Twilio rejected the credentials (HTTP 401). Check that the Account SID and Auth Token are correct and belong to the same account.");
    }
    if (response.status === 403) {
      throw new Error("Twilio denied access (HTTP 403). Check account permissions and whether these credentials belong to the account holding the WhatsApp sender.");
    }
    const detail = String(data.message || data.detail || "").slice(0, 220);
    throw new Error("Twilio sender lookup failed (HTTP " + response.status + ")" + code + (detail ? ": " + detail : "."));
  }

  const senders = Array.isArray(data.senders) ? data.senders : [];
  if (!senders.length) {
    return {
      found: false,
      online: false,
      senderId: null,
      phoneNumber: null,
      status: "NOT_FOUND"
    };
  }

  const selected = senders.find(sender => sender.status === "ONLINE") || senders[0];
  const senderId = String(selected.sender_id || selected.senderId || "");
  const phoneNumber = senderId.startsWith("whatsapp:") ? senderId.slice(9) : senderId;

  if (!phoneNumber) {
    throw new Error("Twilio returned sender records, but no sender phone number was present. Check the sender details in Twilio Console.");
  }

  return {
    found: true,
    online: selected.status === "ONLINE",
    senderId,
    phoneNumber,
    status: String(selected.status || "UNKNOWN"),
    senderSid: selected.sid || null
  };
}
