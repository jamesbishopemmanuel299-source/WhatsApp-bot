export async function reviewSignal(signal, apiKey, model) {
  if (!apiKey || signal.action === "WAIT") return { approved: false, reason: signal.reason };
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: "system", content: "You are a cautious trading risk filter. You do not predict profits. Approve only a clear, internally consistent technical signal. Reply as JSON: {\"approved\":true|false,\"reason\":\"short reason\"}. If uncertain, reject." },
        { role: "user", content: JSON.stringify(signal) }
      ]
    })
  });
  if (!response.ok) throw new Error(`Groq request failed: ${response.status}`);
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    return { approved: parsed.approved === true, reason: String(parsed.reason || "AI risk filter") };
  } catch {
    return { approved: false, reason: "AI response was not valid JSON" };
  }
}
