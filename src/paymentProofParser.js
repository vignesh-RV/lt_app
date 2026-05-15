const MONTHS = new Set([
  "jan", "january", "feb", "february", "mar", "march", "apr", "april",
  "may", "jun", "june", "jul", "july", "aug", "august", "sep", "sept",
  "september", "oct", "october", "nov", "november", "dec", "december"
]);

export function parsePaymentProofText(rawText) {
  const text = normalize(rawText);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

  const amount = extractAmount(text);
  const status = extractStatus(text);
  const transactionId = extractTransactionId(text);
  const utr = extractUtr(text);
  const transactionDateText = extractDateText(text, lines);
  const payeeName = extractPayeeName(lines);
  const payeeVpa = extractVpa(text);
  const payerName = extractPayerName(lines);
  const payerAccountHint = extractAccountHint(text);
  const appName = extractAppName(text);

  return {
    status,
    isSuccessful: status === "success",
    amount,
    transactionId,
    utr,
    uniqueReference: transactionId || utr,
    transactionDateText,
    payeeName,
    payeeVpa,
    payerName,
    payerAccountHint,
    appName,
    rawText
  };
}

function normalize(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[₹¥]/g, "Rs ")
    .replace(/[ \t]+/g, " ");
}

function extractStatus(text) {
  if (/\b(processing|being sent|pending)\b/i.test(text)) {
    return "processing";
  }
  if (/\b(transaction successful|payment successful|paid successfully|paid securely|successful)\b/i.test(text)
      || /\bpaid to\b/i.test(text)) {
    return "success";
  }
  if (/\b(failed|declined|cancelled|canceled)\b/i.test(text)) {
    return "failed";
  }
  return "unknown";
}

function extractAmount(text) {
  const matches = [...text.matchAll(/(?:\b(?:Rs\.?|INR)\s*|[?]\s*|[-=]\s*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)\b/gi)];
  if (matches.length === 0) {
    return "";
  }
  return matches[0][1].replace(/,/g, "");
}

function extractTransactionId(text) {
  const patterns = [
    /\bTransaction\s*ID\s*[:\-]?\s*([A-Z]?[0-9A-Z]{8,})\b/i,
    /\bUPI\s*txn\s*ID\s*[:\-]?\s*([0-9A-Z]{6,})\b/i,
    /\bTxn\s*ID\s*[:\-]?\s*([0-9A-Z]{6,})\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return cleanToken(match[1]);
    }
  }
  return "";
}

function extractUtr(text) {
  const match = text.match(/\bUTR\s*[:\-]?\s*([0-9A-Z]{6,})\b/i);
  return match ? cleanToken(match[1]) : "";
}

function extractDateText(text, lines) {
  const match = text.match(/\b([0-3]?\d[\s-]+[A-Za-z]{3,9}[\s-]+\d{4},?\s+[0-2]?\d[:.][0-5]\d\s*(?:am|pm)?)\b/i)
    || text.match(/\b([0-3]?\d[\-/][01]?\d[\-/]\d{2,4},?\s+[0-2]?\d[:.][0-5]\d\s*(?:am|pm)?)\b/i);
  if (match) {
    return match[1].replace(/\s+/g, " ").trim();
  }

  return lines.find((line) => {
    const words = line.toLowerCase().split(/\s+/);
    return words.some((word) => MONTHS.has(word.replace(/[,.-]/g, ""))) && /\d/.test(line);
  }) || "";
}

function extractPayeeName(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/^(paid to|to|sent to)$/i.test(lines[i]) && lines[i + 1]) {
      return stripAmount(lines[i + 1]);
    }
    const inline = lines[i].match(/\b(?:paid to|to|sent to)\s+([A-Z][A-Z .]{3,})/i);
    if (inline) {
      return stripAmount(inline[1]);
    }
  }
  return "";
}

function extractPayerName(lines) {
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/\bfrom\s+(.+)$/i);
    if (inline) {
      return stripAmount(inline[1]);
    }
    if (/^from$/i.test(lines[i]) && lines[i + 1]) {
      return stripAmount(lines[i + 1]);
    }
  }
  return "";
}

function extractVpa(text) {
  const match = text.match(/\b([A-Za-z0-9._-]{2,256}@[A-Za-z0-9._-]{2,64})\b/);
  return match ? match[1] : "";
}

function extractAccountHint(text) {
  const match = text.match(/\b(?:X{2,}|x{2,}|[*]{2,})[0-9A-Za-z]{2,}\b/)
    || text.match(/\b[A-Z ]*BANK\s*-\s*([0-9]{3,6})\b/i);
  return match ? cleanToken(match[1] || match[0]) : "";
}

function extractAppName(text) {
  if (/\bPhonePe\b/i.test(text)) {
    return "PhonePe";
  }
  if (/\bG\s*Pay|Google\s*Pay\b/i.test(text)) {
    return "Google Pay";
  }
  if (/\bNavi\b/i.test(text)) {
    return "Navi";
  }
  if (/\bPaytm\b/i.test(text)) {
    return "Paytm";
  }
  return "";
}

function stripAmount(value) {
  return value
    .replace(/(?:\b(?:Rs\.?|INR)\s*|[?]\s*|[-=]\s*)[0-9][0-9,]*(?:\.[0-9]{1,2})?\b/gi, "")
    .replace(/[•:]/g, " ")
    .replace(/[=\-\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanToken(value) {
  return String(value || "").replace(/[.,;:]+$/g, "").trim();
}
