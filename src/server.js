import cors from "cors";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs/promises";
import multer from "multer";
import { config } from "./config.js";
import { closePool, query } from "./db.js";
import { listCredits, upsertCredit } from "./creditsRepository.js";
import { validateCreditPayload } from "./validateCredit.js";
import {
  createOutboundMessage,
  createPredictionRequest,
  reconcilePaymentProof,
  upsertCustomer
} from "./workflowRepository.js";
import {
  listShowResults,
  listWinners,
  markWinnerDisbursed,
  upsertShowResultAndCalculateWinners
} from "./winningsRepository.js";
import { parsePaymentProofText } from "./paymentProofParser.js";
import { readImageText } from "./ocrService.js";

const app = express();
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 8 * 1024 * 1024
  }
});

app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.get("/health", async (_req, res, next) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/credits", async (req, res, next) => {
  try {
    const validation = validateCreditPayload(req.body || {});
    if (!validation.ok) {
      res.status(400).json({ ok: false, errors: validation.errors });
      return;
    }

    const credit = await upsertCredit(validation.credit);
    res.status(201).json({ ok: true, credit });
  } catch (error) {
    next(error);
  }
});

app.get("/api/credits", async (req, res, next) => {
  try {
    const requestedLimit = Number(req.query.limit || 50);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 50, 1), 200);
    const credits = await listCredits(limit);
    res.json({ ok: true, credits });
  } catch (error) {
    next(error);
  }
});

app.post("/api/whatsapp/messages", async (req, res, next) => {
  try {
    const body = req.body || {};
    const normalized = normalizeWhatsappMessagePayload(body);
    const { whatsappSender, rawText, displayName, phoneNumber, receivedAt } = normalized;

    const customer = await upsertCustomer({ whatsappSender, displayName, phoneNumber });
    const { predictionRequest, matchedRule } = await createPredictionRequest({
      customer,
      rawText,
      messageSource: "WhatsApp",
      receivedAt
    });

    let outboundMessage = null;
    if (predictionRequest.status === "pending_payment") {
      outboundMessage = await createOutboundMessage({
        customerId: customer.id,
        predictionRequestId: predictionRequest.id,
        whatsappSender,
        messageText: `Your prediction price is Rs ${predictionRequest.calculatedPrice}. Please pay via UPI and share the payment screenshot.`
      });
    }

    res.status(201).json({
      ok: true,
      customer,
      predictionRequest,
      matchedRule,
      outboundMessage,
      normalizedInput: normalized.debug
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/payment-proofs/reconcile", async (req, res, next) => {
  try {
    const body = req.body || {};
    const errors = [];
    const amount = Number(body.amount);
    const predictionRequestId = Number(body.predictionRequestId);
    const whatsappSender = stringValue(body.whatsappSender || body.sender);

    if (!whatsappSender) {
      errors.push("whatsappSender is required");
    }
    if (!Number.isInteger(predictionRequestId) || predictionRequestId <= 0) {
      errors.push("predictionRequestId is required");
    }
    if (!Number.isFinite(amount) || amount < 0) {
      errors.push("amount must be a valid number");
    }

    if (errors.length > 0) {
      res.status(400).json({ ok: false, errors });
      return;
    }

    const result = await reconcilePaymentProof({
      whatsappSender,
      displayName: stringValue(body.displayName),
      phoneNumber: stringValue(body.phoneNumber),
      predictionRequestId,
      amount,
      transactionId: stringValue(body.transactionId),
      transactionDateText: stringValue(body.transactionDateText),
      screenshotPath: stringValue(body.screenshotPath),
      rawText: stringValue(body.rawText)
    });

    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/payment-proofs/parse-text", (req, res) => {
  const rawText = stringValue(req.body?.rawText);
  if (!rawText) {
    res.status(400).json({ ok: false, errors: ["rawText is required"] });
    return;
  }
  res.json({ ok: true, paymentProof: parsePaymentProofText(rawText) });
});

app.post("/api/payment-proofs/ocr", upload.single("screenshot"), async (req, res, next) => {
  if (!req.file) {
    res.status(400).json({ ok: false, errors: ["screenshot file is required"] });
    return;
  }

  try {
    const rawText = await readImageText(req.file.path);
    res.json({
      ok: true,
      rawText,
      paymentProof: parsePaymentProofText(rawText)
    });
  } catch (error) {
    next(error);
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

app.get("/api/outbound-messages", async (req, res, next) => {
  try {
    const requestedLimit = Number(req.query.limit || 50);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 50, 1), 200);
    const result = await query(
      `
        SELECT
          id,
          customer_id AS "customerId",
          prediction_request_id AS "predictionRequestId",
          whatsapp_sender AS "whatsappSender",
          message_text AS "messageText",
          status,
          created_at AS "createdAt"
        FROM outbound_messages
        WHERE status = 'pending_manual_send'
        ORDER BY created_at ASC
        LIMIT $1
      `,
      [limit]
    );
    res.json({ ok: true, outboundMessages: result.rows });
  } catch (error) {
    next(error);
  }
});

app.post("/api/show-results", async (req, res, next) => {
  try {
    const body = req.body || {};
    const resultDate = stringValue(body.resultDate);
    const gameShow = stringValue(body.gameShow);
    const market = stringValue(body.market);
    const winningNumber = stringValue(body.winningNumber);
    const errors = [];

    if (!/^\d{4}-\d{2}-\d{2}$/.test(resultDate)) {
      errors.push("resultDate is required in YYYY-MM-DD format");
    }
    if (!gameShow) {
      errors.push("gameShow is required");
    }
    if (!market) {
      errors.push("market is required");
    }
    if (!/^\d{1,4}$/.test(winningNumber)) {
      errors.push("winningNumber must be 1 to 4 digits");
    }

    if (errors.length > 0) {
      res.status(400).json({ ok: false, errors });
      return;
    }

    const result = await upsertShowResultAndCalculateWinners({
      resultDate,
      gameShow,
      market,
      winningNumber,
      enteredBy: stringValue(body.enteredBy),
      notes: stringValue(body.notes)
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.get("/api/show-results", async (req, res, next) => {
  try {
    const requestedLimit = Number(req.query.limit || 30);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 30, 1), 200);
    const showResults = await listShowResults(limit);
    res.json({ ok: true, showResults });
  } catch (error) {
    next(error);
  }
});

app.get("/api/winners", async (req, res, next) => {
  try {
    const requestedLimit = Number(req.query.limit || 100);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 100, 1), 500);
    const showResultId = req.query.showResultId ? Number(req.query.showResultId) : null;
    const status = stringValue(req.query.status);
    const winners = await listWinners({ showResultId, status, limit });
    res.json({ ok: true, winners });
  } catch (error) {
    next(error);
  }
});

app.post("/api/winners/:id/disburse", async (req, res, next) => {
  try {
    const winnerId = Number(req.params.id);
    if (!Number.isInteger(winnerId) || winnerId <= 0) {
      res.status(400).json({ ok: false, errors: ["winner id must be a positive number"] });
      return;
    }
    const winner = await markWinnerDisbursed({
      winnerId,
      reference: stringValue(req.body?.reference),
      notes: stringValue(req.body?.notes)
    });
    if (!winner) {
      res.status(404).json({ ok: false, errors: ["winner not found"] });
      return;
    }
    res.json({ ok: true, winner });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    ok: false,
    error: "Internal server error"
  });
});

const server = app.listen(config.port, () => {
  console.log(`WA Bank Monitor API listening on http://localhost:${config.port}`);
});

async function shutdown() {
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function stringValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function normalizeWhatsappMessagePayload(payload) {
  const leaves = flattenPayload(payload);
  const payloadText = stableJson(payload);
  const rawText = pickText(leaves) || payloadText || "";
  const phoneNumber = pickPhone(leaves);
  const whatsappSender = pickSender(leaves) || phoneNumber || `unknown_${shortHash(payloadText || Date.now())}`;
  const displayName = pickDisplayName(leaves);
  const receivedAt = pickReceivedAt(leaves);

  return {
    whatsappSender,
    rawText,
    displayName,
    phoneNumber,
    receivedAt,
    debug: {
      whatsappSender,
      hasRawText: Boolean(rawText),
      displayName,
      phoneNumber,
      receivedAt: receivedAt.toISOString()
    }
  };
}

function flattenPayload(value, path = [], output = []) {
  if (value === null || value === undefined) {
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenPayload(item, path.concat(String(index)), output));
    return output;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flattenPayload(child, path.concat(key), output);
    }
    return output;
  }
  output.push({
    key: path[path.length - 1] || "",
    path: path.join("."),
    value,
    text: stringValue(value)
  });
  return output;
}

function pickText(leaves) {
  const preferred = pickByKey(leaves, [
    "rawText",
    "messageText",
    "message_text",
    "body",
    "text",
    "message",
    "msg",
    "caption",
    "content",
    "description"
  ], true);
  if (preferred) {
    return preferred;
  }

  return leaves
    .map((leaf) => leaf.text)
    .filter((text) => text.length >= 3 && !looksLikePhone(text) && !looksLikeTimestamp(text))
    .sort((a, b) => b.length - a.length)[0] || "";
}

function pickSender(leaves) {
  const value = pickByKey(leaves, [
    "whatsappSender",
    "whatsapp_sender",
    "sender",
    "senderId",
    "sender_id",
    "from",
    "author",
    "participant",
    "remoteJid",
    "jid",
    "waId",
    "wa_id",
    "mobile",
    "phone",
    "phoneNumber",
    "phone_number"
  ], false);
  return normalizeSender(value);
}

function pickPhone(leaves) {
  const value = pickByKey(leaves, [
    "phoneNumber",
    "phone_number",
    "mobile",
    "mobileNumber",
    "contactNumber",
    "customerMobile",
    "customer_mobile",
    "phone",
    "from"
  ], false);
  return normalizePhone(value);
}

function pickDisplayName(leaves) {
  return pickByKey(leaves, [
    "displayName",
    "display_name",
    "contactName",
    "contact_name",
    "customerName",
    "customer_name",
    "pushName",
    "push_name",
    "name",
    "profileName"
  ], true);
}

function pickReceivedAt(leaves) {
  const value = pickByKey(leaves, [
    "timestamp",
    "time",
    "receivedAt",
    "received_at",
    "createdAt",
    "created_at",
    "date",
    "datetime"
  ], false);
  const parsed = parseFlexibleDate(value);
  return parsed || new Date();
}

function pickByKey(leaves, keys, requireText) {
  const normalizedKeys = keys.map(normalizeKey);
  for (const leaf of leaves) {
    if (!leaf.text) {
      continue;
    }
    const key = normalizeKey(leaf.key);
    const path = normalizeKey(leaf.path);
    const matched = normalizedKeys.some((candidate) => key === candidate || path.endsWith(candidate));
    if (matched && (!requireText || typeof leaf.value === "string")) {
      return leaf.text;
    }
  }
  return "";
}

function normalizeKey(value) {
  return stringValue(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function normalizeSender(value) {
  const text = stringValue(value);
  if (!text) {
    return "";
  }
  const phone = normalizePhone(text);
  if (phone) {
    return phone;
  }
  return text.replace(/\s+/g, "_").slice(0, 120);
}

function normalizePhone(value) {
  const text = stringValue(value);
  const match = text.match(/\+?\d[\d\s().-]{7,}\d/);
  if (!match) {
    return "";
  }
  return match[0].replace(/[^\d]/g, "");
}

function parseFlexibleDate(value) {
  const text = stringValue(value);
  if (!text) {
    return null;
  }
  const number = Number(text);
  if (Number.isFinite(number) && number > 0) {
    const millis = number > 9999999999 ? number : number * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function looksLikePhone(value) {
  return Boolean(normalizePhone(value));
}

function looksLikeTimestamp(value) {
  const parsed = parseFlexibleDate(value);
  return Boolean(parsed);
}

function stableJson(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return "";
  }
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}
