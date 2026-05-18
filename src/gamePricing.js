import { query } from "./db.js";

const SHOWS = [
  { code: "1PM_DEAR", label: "1PM Dear", market: "Dear", hour: 13, minute: 0 },
  { code: "3PM_KL", label: "3PM KL", market: "KL", hour: 15, minute: 0 },
  { code: "6PM_DEAR", label: "6PM Dear", market: "Dear", hour: 18, minute: 0 },
  { code: "8PM_DEAR", label: "8PM Dear", market: "Dear", hour: 20, minute: 0 }
];
const COMPACT_PREDICTION_RE = /\b(?:(AB|BC|AC|A|B|C)[\s_-]*)?(\d{1,4})\s*[=_-]\s*(\d{1,3})\s*(?:sets|set|sef|s)?\b/gi;

const PRICE_RE = /\b(?:rs\.?|inr|₹)\s*([0-9]+(?:\.[0-9]{1,2})?)\b/i;
const TRAILING_PRICE_RE = /\b([0-9]+(?:\.[0-9]{1,2})?)\s*(?:rs\.?|inr|₹)\b/i;

export async function calculatePredictionPricing(rawText, receivedAt = new Date()) {
  const text = String(rawText || "").trim();
  if (!text) {
    return null;
  }

  const alreadyPricedPreview = detectAlreadyPricedTicketPreview(text);
  if (alreadyPricedPreview.detected) {
    return {
      manualWork: true,
      rule: null,
      show: inferShow("", receivedAt),
      market: inferMarket(text, receivedAt),
      gameType: "Manual Work Candidate",
      unitPrice: "0.00",
      quantity: 0,
      totalPrice: null,
      numbers: [],
      breakdown: {
        manualWork: true,
        alreadyPriced: true,
        reason: alreadyPricedPreview.reason,
        providedTotal: alreadyPricedPreview.providedTotal,
        unmatchedPercent: 100,
        unmatchedTokens: [],
        totalTokens: 0,
        matchedTokens: 0,
        entries: []
      }
    };
  }

  const formatCompliance = analyzePricingFormat(text);
  if (formatCompliance.manualWork) {
    return {
      manualWork: true,
      rule: null,
      show: inferShow("", receivedAt),
      market: inferMarket(text, receivedAt),
      gameType: "Manual Work Candidate",
      unitPrice: "0.00",
      quantity: 0,
      totalPrice: null,
      numbers: [],
      breakdown: {
        manualWork: true,
        reason: formatCompliance.reason,
        unmatchedPercent: formatCompliance.unmatchedPercent,
        unmatchedTokens: formatCompliance.unmatchedTokens,
        totalTokens: formatCompliance.totalTokens,
        matchedTokens: formatCompliance.matchedTokens,
        entries: []
      }
    };
  }

  const market = inferMarket(text, receivedAt);
  const show = inferShow(text, receivedAt, market);
  const parsedEntries = parsePredictionEntries(text);
  if (parsedEntries.length === 0) {
    return null;
  }

  const pricedEntries = [];
  let totalPrice = 0;
  let totalQuantity = 0;

  for (const entry of parsedEntries) {
    if (entry.unitPrice === null) {
      entry.unitPrice = await findDefaultUnitPrice({
        digitCount: entry.digitCount,
        market,
        positionCode: entry.positionCode
      });
    }
    if (entry.unitPrice === null) {
      pricedEntries.push({ ...entry, matched: false, reason: "No unit price found for digit rule" });
      continue;
    }

    let rule = await findGameRule({
      unitPrice: entry.unitPrice,
      digitCount: entry.digitCount,
      market,
      positionCode: entry.positionCode
    });
    let fallbackReason = "";

    if (!rule) {
      const fallbackUnitPrice = await findDefaultUnitPrice({
        digitCount: entry.digitCount,
        market,
        positionCode: entry.positionCode
      });
      if (fallbackUnitPrice !== null && fallbackUnitPrice !== entry.unitPrice) {
        fallbackReason = `Mentioned/current Rs ${entry.unitPrice} is not valid for this digit rule; used lowest valid Rs ${fallbackUnitPrice}`;
        entry.unitPrice = fallbackUnitPrice;
        rule = await findGameRule({
          unitPrice: entry.unitPrice,
          digitCount: entry.digitCount,
          market,
          positionCode: entry.positionCode
        });
      }
    }

    const lineTotal = Number(entry.unitPrice) * entry.units;
    totalPrice += lineTotal;
    totalQuantity += entry.units;
    if (!rule) {
      pricedEntries.push({
        ...entry,
        matched: false,
        reason: fallbackReason || "No matching win-tier rule; charged by applied unit price",
        lineTotal: lineTotal.toFixed(2)
      });
      continue;
    }

    pricedEntries.push({
      ...entry,
      matched: true,
      ruleId: rule.id,
      ruleKey: rule.gameKey,
      ruleLabel: rule.label,
      winTiers: rule.winTiers,
      reason: fallbackReason,
      lineTotal: lineTotal.toFixed(2)
    });
  }

  if (totalQuantity === 0) {
    return null;
  }

  const firstMatched = pricedEntries.find((entry) => entry.matched);
  return {
    rule: firstMatched
      ? {
          id: firstMatched.ruleId,
          gameKey: firstMatched.ruleKey,
          label: firstMatched.ruleLabel,
          unitPrice: firstMatched.unitPrice,
          winTiers: firstMatched.winTiers
        }
      : null,
    show,
    market,
    gameType: "Mixed Prediction",
    unitPrice: firstMatched ? Number(firstMatched.unitPrice).toFixed(2) : "0.00",
    quantity: totalQuantity,
    totalPrice: totalPrice.toFixed(2),
    numbers: pricedEntries.flatMap((entry) => entry.numbers),
    breakdown: {
      totalPrice,
      quantity: totalQuantity,
      market,
      show,
      entries: pricedEntries,
      assumptions: buildAssumptions(text, market, show)
    }
  };
}

export function parsePredictionEntries(rawText) {
  const lines = normalizeText(rawText)
    .split("\n")
    .map((line) => line.trim());

  const entries = [];
  let pending = [];
  let currentPrice = null;
  let currentMode = "";
  let activeContextEntryStart = 0;

  for (const line of lines) {
    if (!line) {
      if (pending.length > 0) {
        entries.push(...materializeEntries(pending, currentPrice));
        pending = [];
      }
      currentMode = "";
      activeContextEntryStart = entries.length;
      continue;
    }

    const context = readContext(line);
    if (context) {
      currentMode = context;
      activeContextEntryStart = entries.length;
    }

    const price = readPrice(line);
    const predictions = readPredictions(line, price);
    const numbers = predictions.map((prediction) => prediction.number);
    const explicitSet = predictions.some((prediction) => prediction.explicitUnits) ? null : readSetQuantity(line);
    const eachSet = readEachSetQuantity(line);
    const priceOnly = price !== null && numbers.length === 0;

    if (eachSet !== null) {
      pending = pending.map((entry) => entry.explicitUnits ? entry : { ...entry, setCount: eachSet });
      for (let i = activeContextEntryStart; i < entries.length; i++) {
        if (!entries[i].explicitUnits) {
          entries[i] = rebuildEntryWithSetCount(entries[i], eachSet);
        }
      }
      continue;
    }

    if (explicitSet !== null && numbers.length === 0) {
      pending = pending.map((entry) => entry.explicitUnits ? entry : { ...entry, setCount: explicitSet });
      for (let i = activeContextEntryStart; i < entries.length; i++) {
        if (!entries[i].explicitUnits) {
          entries[i] = rebuildEntryWithSetCount(entries[i], explicitSet);
        }
      }
      continue;
    }

    if (priceOnly) {
      if (pending.length > 0) {
        entries.push(...materializeEntries(pending, price));
        pending = [];
      }
      currentPrice = price;
      continue;
    }

    if (numbers.length === 0) {
      continue;
    }

    const baseEntries = predictions.map((prediction) => ({
      rawLine: line,
      mode: resolveMode(prediction.mode || context || currentMode, prediction.number),
      number: normalizePredictionNumber(prediction.mode || context || currentMode, prediction.number),
      originalNumber: prediction.number,
      setCount: prediction.explicitUnits ? prediction.setCount : (explicitSet || prediction.setCount || 1),
      explicitUnits: prediction.explicitUnits || explicitSet !== null
    }));

    if (price !== null) {
      if (pending.length > 0) {
        entries.push(...materializeEntries(pending, price));
        pending = [];
      }
      entries.push(...materializeEntries(baseEntries, price));
      currentPrice = price;
    } else if (currentPrice !== null) {
      entries.push(...materializeEntries(baseEntries, currentPrice));
    } else {
      pending.push(...baseEntries);
    }
  }

  if (pending.length > 0) {
    entries.push(...materializeEntries(pending, currentPrice));
  }

  return entries;
}

async function findGameRule({ unitPrice, digitCount, market, positionCode }) {
  const result = await query(
    `
      SELECT
        id,
        game_key AS "gameKey",
        label,
        digit_count AS "digitCount",
        unit_price::TEXT AS "unitPrice",
        allowed_markets AS "allowedMarkets",
        position_code AS "positionCode",
        win_tiers AS "winTiers"
      FROM game_pricing_rules
      WHERE is_active = TRUE
        AND unit_price = $1
        AND digit_count = $2
        AND (array_length(allowed_markets, 1) IS NULL OR $3 = ANY(allowed_markets))
        AND (
          position_code IS NULL
          OR position_code = $4
        )
      ORDER BY
        CASE WHEN position_code = $4 THEN 0 ELSE 1 END,
        priority ASC,
        id ASC
      LIMIT 1
    `,
    [unitPrice, digitCount, market, positionCode || ""]
  );
  return result.rows[0] || null;
}

async function findDefaultUnitPrice({ digitCount, market, positionCode }) {
  let result = await query(
    `
      SELECT unit_price::TEXT AS "unitPrice"
      FROM game_pricing_rules
      WHERE is_active = TRUE
        AND digit_count = $1
        AND (array_length(allowed_markets, 1) IS NULL OR $2 = ANY(allowed_markets))
        AND (
          position_code IS NULL
          OR position_code = $3
        )
      ORDER BY unit_price ASC, priority ASC, id ASC
      LIMIT 1
    `,
    [digitCount, market, positionCode || ""]
  );
  if (result.rows[0]) {
    return Number(result.rows[0].unitPrice);
  }

  result = await query(
    `
      SELECT unit_price::TEXT AS "unitPrice"
      FROM game_pricing_rules
      WHERE is_active = TRUE
        AND digit_count = $1
        AND (array_length(allowed_markets, 1) IS NULL OR $2 = ANY(allowed_markets))
      ORDER BY unit_price ASC, priority ASC, id ASC
      LIMIT 1
    `,
    [digitCount, market]
  );
  return result.rows[0] ? Number(result.rows[0].unitPrice) : null;
}

function materializeEntries(baseEntries, unitPrice) {
  return baseEntries.flatMap((entry) => expandEntry(entry, unitPrice));
}

function expandEntry(entry, unitPrice) {
  const mode = entry.mode;
  const digitCount = entry.number.length;

  if (mode === "ALL") {
    if (digitCount === 1) {
      return [buildEntry(entry, unitPrice, 1, "ALL", ["A", "B", "C"], [entry.number], 3)];
    }
    if (digitCount === 2) {
      return [buildEntry(entry, unitPrice, 2, "ALL", ["AB", "AC", "BC"], [entry.number], 3)];
    }
  }

  if (mode === "BOX") {
    if (digitCount === 1) {
      return [buildEntry(entry, unitPrice, 1, "BOX", ["A", "B", "C"], [entry.number], 1)];
    }
    if (digitCount === 2) {
      return [buildEntry(entry, unitPrice, 2, "BOX", ["AB", "AC", "BC"], [entry.number], 3)];
    }
    if (digitCount === 3) {
      const variants = uniquePermutations(entry.number);
      return [buildEntry(entry, unitPrice, 3, "BOX", variants, variants, variants.length)];
    }
  }

  if (["AB", "BC", "AC"].includes(mode)) {
    return [buildEntry(entry, unitPrice, 2, mode, [mode], [entry.number], 1)];
  }

  if (["A", "B", "C"].includes(mode)) {
    return [buildEntry(entry, unitPrice, 1, mode, [mode], [entry.number], 1)];
  }

  return [buildEntry(entry, unitPrice, digitCount, mode || "DIRECT", [], [entry.number], 1)];
}

function buildEntry(entry, unitPrice, digitCount, gameMode, expandedBoards, numbers, expansionCount) {
  const units = entry.setCount * expansionCount;
  return {
    rawLine: entry.rawLine,
    originalNumber: entry.originalNumber,
    normalizedNumber: entry.number,
    warning: buildEntryWarning(entry),
    gameMode,
    positionCode: ["AB", "BC", "AC"].includes(gameMode) ? gameMode : "",
    digitCount,
    unitPrice,
    setCount: entry.setCount,
    explicitUnits: entry.explicitUnits,
    expansionCount,
    units,
    numbers,
    expandedBoards
  };
}

function buildEntryWarning(entry) {
  if (entry.originalNumber && entry.originalNumber !== entry.number) {
    return `Normalized ${entry.originalNumber} to ${entry.number} for ${entry.mode} board.`;
  }
  return "";
}

function rebuildEntryWithSetCount(entry, setCount) {
  const units = setCount * entry.expansionCount;
  return {
    ...entry,
    setCount,
    units
  };
}

function normalizeText(text) {
  return String(text || "")
    .replace(/(\d)\s*sR\s*(\d)/gi, "$1 Rs$2")
    .replace(/\b(\d+(?:\.\d{1,2})?)\s*(rs\.?|inr|₹)\s*(boxs?)\b/gi, "$1$2 $3")
    .replace(/\b(rs\.?|inr|₹)\s*(\d+(?:\.\d{1,2})?)\s*(boxs?)\b/gi, "$1$2 $3")
    .replace(/[.…]+/g, "-")
    .replace(/[–—]/g, "-")
    .replace(/\r/g, "\n");
}

function readContext(line) {
  const compact = line.match(/\b(AB|BC|AC|A|B|C)[\s_-]*\d{1,4}\s*[=_-]/i);
  if (compact) {
    return compact[1].toUpperCase();
  }
  const prefixed = line.match(/\b(AB|BC|AC|A|B|C)[\s_-]*\d{1,4}\b/i);
  if (prefixed) {
    return prefixed[1].toUpperCase();
  }
  if (/\bboxs?\b|\bboxs?\d|\d\s*(?:rs\.?|inr|₹)\s*boxs?|\b(?:rs\.?|inr|₹)\s*\d+(?:\.\d{1,2})?\s*boxs?/i.test(line)) {
    return "BOX";
  }
  if (/^\s*all\b/i.test(line)) {
    return "ALL";
  }
  const match = line.match(/\b(AB|BC|AC|A|B|C)\b/i);
  return match ? match[1].toUpperCase() : "";
}

function readPrice(line) {
  const match = line.match(PRICE_RE) || line.match(TRAILING_PRICE_RE);
  return match ? Number(match[1]) : null;
}

function readSetQuantity(line) {
  const match = line.match(/\b([0-9]+)\W{0,4}(?:sets?|sef|s)\b/i);
  return match ? Number(match[1]) : null;
}

function readEachSetQuantity(line) {
  const match = line.match(/\b(?:each|e)\s*([0-9]+)\W{0,4}(?:sets?|sef|s)\b/i);
  return match ? Number(match[1]) : null;
}

function readNumbers(line, price) {
  return readPredictions(line, price).map((prediction) => prediction.number);
}

function readPredictions(line, price) {
  const compactBox = line.match(/^\s*boxs?\s*(\d{1,4}(?:\s*,\s*\d{1,4})*)\s*[-=]\s*(\d{1,3})\s*(?:sets|set|sef|s)?\s*$/i);
  if (compactBox) {
    return compactBox[1]
      .split(/\s*,\s*/)
      .filter(Boolean)
      .map((number) => ({ mode: "BOX", number, setCount: Number(compactBox[2]), explicitUnits: true }));
  }

  const boxList = line.match(/^\s*boxs?\s*(\d{1,4}(?:\s*,\s*\d{1,4})*)\s*$/i);
  if (boxList) {
    return boxList[1]
      .split(/\s*,\s*/)
      .filter(Boolean)
      .map((number) => ({ mode: "BOX", number, setCount: 1, explicitUnits: false }));
  }

  const compactPredictions = [];
  let cleaned = line.replace(COMPACT_PREDICTION_RE, (_match, mode, number, setCount) => {
    compactPredictions.push({
      mode: mode ? mode.toUpperCase() : "",
      number,
      setCount: Number(setCount),
      explicitUnits: true
    });
    return " ";
  });

  if (compactPredictions.length > 0 && cleaned.trim() === "") {
    return compactPredictions;
  }

  const tokenPredictions = [];
  cleaned = cleaned.replace(/\b(AB|BC|AC|A|B|C)?\s*(\d{1,4})(?=\s*[-,_]|$)/gi, (match, mode, number) => {
    if (mode || tokenPredictions.length > 0) {
      tokenPredictions.push({
        mode: mode ? mode.toUpperCase() : "",
        number,
        setCount: 1,
        explicitUnits: false
      });
      return " ";
    }
    return match;
  });

  cleaned = cleaned
    .replace(/\b(?:rs\.?|inr)\s*\d+(?:\.\d{1,2})?\b/gi, " ")
    .replace(/\b\d+(?:\.\d{1,2})?\s*(?:rs\.?|inr)\b/gi, " ")
    .replace(PRICE_RE, " ")
    .replace(TRAILING_PRICE_RE, " ")
    .replace(/\b\d{1,2}\s*(?:am|pm)\b/gi, " ")
    .replace(/\b[1-4]\s*(?:digit|digital|board)\b/gi, " ")
    .replace(/\b[0-9]+\W{0,4}(?:sets?|sef|s)\b/gi, " ")
    .replace(/\b(?:each|e)\s*[0-9]+\W{0,4}(?:sets?|sef|s)\b/gi, " ")
    .replace(/\beach\b/gi, " ")
    .replace(/\b(?:boxs?|all|ab|bc|ac|single|board|digit|rs|inr|kl|dear|dr)\b/gi, " ");

  if (price !== null) {
    cleaned = cleaned.replace(new RegExp(`\\b${price}\\b`), " ");
  }

  const pair = cleaned.trim().match(/^(\d{1,4})\s*[-,_]\s*(\d{1,3})$/);
  if (pair) {
    return [...compactPredictions, { mode: "", number: pair[1], setCount: Number(pair[2]), explicitUnits: true }];
  }

  return [
    ...compactPredictions,
    ...tokenPredictions,
    ...(cleaned.match(/\b\d{1,4}\b/g) || []).map((number) => ({ mode: "", number, setCount: 1, explicitUnits: false }))
  ];
}

function inferModeFromNumber(number) {
  if (number.length === 1) {
    return "A";
  }
  return "DIRECT";
}

function resolveMode(mode, number) {
  const normalized = mode || "";
  if (["AB", "BC", "AC"].includes(normalized) && number.length > 2) {
    return inferModeFromNumber(number);
  }
  if (["A", "B", "C"].includes(normalized) && number.length !== 1) {
    return inferModeFromNumber(number);
  }
  return normalized || inferModeFromNumber(number);
}

function normalizePredictionNumber(mode, number) {
  if (["AB", "BC", "AC"].includes(mode) && number.length === 1) {
    return number.padStart(2, "0");
  }
  return number;
}

function uniquePermutations(value) {
  const results = new Set();
  function walk(prefix, rest) {
    if (!rest) {
      results.add(prefix);
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      walk(prefix + rest[i], rest.slice(0, i) + rest.slice(i + 1));
    }
  }
  walk("", value);
  return [...results];
}

function inferMarket(text, receivedAt) {
  if (/\bKL\b|only\s*kl/i.test(text)) {
    return "KL";
  }
  if (/\bDR\b|\bDear\b/i.test(text)) {
    return "Dear";
  }
  return inferShow("", receivedAt).market;
}

function inferShow(text, receivedAt, forcedMarket = "") {
  if (/\bKL\b|only\s*kl/i.test(text)) {
    return SHOWS[1];
  }

  const date = new Date(receivedAt);
  const minutes = date.getHours() * 60 + date.getMinutes();
  const show = SHOWS.find((item) => {
    const showMinutes = item.hour * 60 + item.minute;
    return minutes <= showMinutes + 2 && (!forcedMarket || item.market === forcedMarket);
  });
  return show || SHOWS[SHOWS.length - 1];
}

function buildAssumptions(text, market, show) {
  const assumptions = [];
  if (!/\bKL\b|only\s*kl|\bDR\b|\bDear\b/i.test(text)) {
    assumptions.push(`Market inferred as ${market} from message time and show schedule.`);
  }
  assumptions.push("A price-only line applies to pending prediction lines above it and following lines until another price appears.");
  assumptions.push("set means unit quantity; box expands into boards/permutations; duplicates are counted through expansion units.");
  assumptions.push(`Show inferred as ${show.label}.`);
  return assumptions;
}

function detectAlreadyPricedTicketPreview(text) {
  const plainText = String(text || "").replace(/[*_]/g, "");
  const hasTicketPreview = /\bticket\s+preview\b/i.test(plainText);
  const hasTotal = /\btotal\b\D{0,16}\d+(?:\.\d{1,2})?\b/i.test(plainText);
  const hasLineAmount = /(?:\d+\s*[x×]\s*\d+\s*=\D{0,12}\d+)|(?:\(\s*[1-4]d\s*\).*?(?:=|rs\.?|inr|\u20b9|â‚¹|\d+\s*[x×]\s*\d+))/i.test(plainText);

  if (!hasTicketPreview || !hasTotal || !hasLineAmount) {
    return {
      detected: false,
      reason: "",
      providedTotal: null
    };
  }

  return {
    detected: true,
    reason: "Manual work candidate: message is an already-priced ticket preview, so pricing calculation was skipped.",
    providedTotal: extractProvidedTotal(plainText)
  };
}

function extractProvidedTotal(text) {
  const match = String(text || "").match(/\btotal\b\D{0,16}([0-9]+(?:\.[0-9]{1,2})?)\b/i);
  return match ? Number(match[1]).toFixed(2) : null;
}

function analyzePricingFormat(text) {
  const tokens = String(text || "")
    .replace(/[,\n\r]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return {
      manualWork: false,
      totalTokens: 0,
      matchedTokens: 0,
      unmatchedTokens: [],
      unmatchedPercent: 0,
      reason: ""
    };
  }

  const unmatchedTokens = tokens.filter((token) => !isKnownPricingToken(token));
  const unmatchedPercent = Math.round((unmatchedTokens.length / tokens.length) * 10000) / 100;
  return {
    manualWork: unmatchedPercent > 15,
    totalTokens: tokens.length,
    matchedTokens: tokens.length - unmatchedTokens.length,
    unmatchedTokens: unmatchedTokens.slice(0, 20),
    unmatchedPercent,
    reason: unmatchedPercent > 15
      ? `Manual work candidate: ${unmatchedPercent}% of message tokens do not match supported prediction format.`
      : ""
  };
}

function isKnownPricingToken(token) {
  const cleaned = token
    .replace(/^[*#\-:;|]+|[*#\-:;|]+$/g, "")
    .replace(/[.\u2026]+$/g, "")
    .replace(/[.\u2026]+/g, "-")
    .trim();
  if (!cleaned) {
    return true;
  }
  if (/^(a|b|c|ab|bc|ac|all|box|boxs|each|set|sets|sef|rs|inr|single|board|digit|digital|kl|dear|dr)$/i.test(cleaned)) {
    return true;
  }
  if (/^(?:rs\.?|inr|\u20b9)?\d{1,4}(?:\.\d{1,2})?(?:rs\.?|inr)?$/i.test(cleaned)) {
    return true;
  }
  if (/^(?:\d+(?:\.\d{1,2})?(?:rs\.?|inr|\u20b9)|(?:rs\.?|inr|\u20b9)\d+(?:\.\d{1,2})?)boxs?$/i.test(cleaned)) {
    return true;
  }
  if (/^\d{1,4}[-,_]\d{1,3}$/.test(cleaned)) {
    return true;
  }
  if (/^\d{1,4}-+\d{1,3}(?:sets?|rs\.?|inr)?$/i.test(cleaned)) {
    return true;
  }
  if (/^\d{1,3}sets?$/i.test(cleaned)) {
    return true;
  }
  if (/^\d{1,3}(?:s|sef)$/i.test(cleaned)) {
    return true;
  }
  if (/^e\d{1,3}(?:s|set|sets|sef)$/i.test(cleaned)) {
    return true;
  }
  if (/^(?:(?:ab|bc|ac|a|b|c)[\s_-]*)?\d{1,4}[=_-]\d{1,3}(?:s|set|sets|sef)?$/i.test(cleaned)) {
    return true;
  }
  if (/^(?:ab|bc|ac|a|b|c)\d{1,4}$/i.test(cleaned) || /^=\d{1,3}(?:s|set|sets|sef)?$/i.test(cleaned)) {
    return true;
  }
  if (/^\d{1,2}(?:am|pm)$/i.test(cleaned)) {
    return true;
  }
  if (/^\d{1,4}(?:sr|rs)\d{1,3}$/i.test(cleaned)) {
    return true;
  }
  if (/^boxs?-+\d{1,3}-+sets?$/i.test(cleaned)) {
    return true;
  }
  if (/^boxs?\d{1,4}(?:,\d{1,4})*[-=]\d{1,3}(?:sets|set|sef|s)?$/i.test(cleaned)) {
    return true;
  }
  if (/^[abc]{1,2}$/i.test(cleaned)) {
    return true;
  }
  return false;
}
