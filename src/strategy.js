import { EMA, RSI } from "technicalindicators";

export function buildSignal(candles) {
  if (!Array.isArray(candles) || candles.length < 30) {
    return { action: "WAIT", reason: "Not enough candle history", confidence: 0 };
  }
  const closes = candles.map(c => Number(c.close)).filter(Number.isFinite);
  if (closes.length < 30) return { action: "WAIT", reason: "Invalid candle data", confidence: 0 };

  const fast = EMA.calculate({ period: 9, values: closes });
  const slow = EMA.calculate({ period: 21, values: closes });
  const rsi = RSI.calculate({ period: 14, values: closes });
  const a = fast.at(-1), b = slow.at(-1), previousA = fast.at(-2), previousB = slow.at(-2);
  const currentRsi = rsi.at(-1);

  if (![a, b, previousA, previousB, currentRsi].every(Number.isFinite)) {
    return { action: "WAIT", reason: "Indicators unavailable", confidence: 0 };
  }

  const bullishCross = previousA <= previousB && a > b;
  const bearishCross = previousA >= previousB && a < b;
  if (bullishCross && currentRsi >= 50 && currentRsi <= 68) {
    return { action: "CALL", reason: "EMA 9 crossed above EMA 21; RSI confirms momentum", confidence: 0.70, rsi: currentRsi };
  }
  if (bearishCross && currentRsi >= 32 && currentRsi <= 50) {
    return { action: "PUT", reason: "EMA 9 crossed below EMA 21; RSI confirms momentum", confidence: 0.70, rsi: currentRsi };
  }
  return { action: "WAIT", reason: "No confirmed EMA crossover", confidence: 0.25, rsi: currentRsi };
}
