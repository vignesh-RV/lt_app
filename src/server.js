import cors from "cors";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs/promises";
import multer from "multer";
import { config } from "./config.js";
import { adminDashboardRouter } from "./adminDashboardRoutes.js";
import { closePool, query } from "./db.js";
import { listCredits, upsertCredit } from "./creditsRepository.js";
import { checkAppLicense } from "./licenseRepository.js";
import { listListenerAccounts, listSupportSummary, upsertListenerAccount } from "./baileysRepository.js";
import { getBaileysRuntimeStatus, startBaileysListeners } from "./baileysService.js";
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

app.use(cors({
  origin(origin, callback) {
    if (!origin || !config.adminCorsOrigin) {
      callback(null, true);
      return;
    }
    const allowed = config.adminCorsOrigin
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    callback(null, allowed.includes(origin));
  },
  credentials: true
}));
app.use(express.json({
  limit: "256kb",
  verify: (req, _res, buffer) => {
    req.rawBody = buffer.toString("utf8");
  }
}));

const seenSignedRequestNonces = new Map();
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

app.use("/api", verifySignedRequest);
app.use("/admin/api", adminDashboardRouter);
app.use("/admin", express.static("public/admin"));

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
    const license = await checkAppLicense({
      deviceId: req.body?.deviceId || "",
      phoneNumbers: [
        ...(Array.isArray(req.body?.phoneNumbers) ? req.body.phoneNumbers : []),
        req.body?.receivedPhoneNumber || ""
      ]
    });
    if (!license.allowed) {
      res.status(403).json({ ok: false, mode: license.mode, errors: [license.reason] });
      return;
    }

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

app.post("/api/app-license/check", async (req, res, next) => {
  try {
    const license = await checkAppLicense({
      deviceId: req.body?.deviceId || "",
      phoneNumbers: Array.isArray(req.body?.phoneNumbers) ? req.body.phoneNumbers : []
    });
    res.json({ ok: true, ...license });
  } catch (error) {
    next(error);
  }
});

app.post("/api/app-credit-health", async (req, res, next) => {
  try {
    const license = await checkAppLicense({
      deviceId: req.body?.deviceId || "",
      phoneNumbers: Array.isArray(req.body?.phoneNumbers) ? req.body.phoneNumbers : []
    });
    if (!license.allowed) {
      res.status(403).json({ ok: false, mode: license.mode, reason: license.reason });
      return;
    }

    res.json({
      ok: true,
      status: "connected",
      creditApiConfigured: Boolean(license.creditApi?.baseUrl || license.creditApi?.path)
    });
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

app.get("/api/baileys/accounts", async (_req, res, next) => {
  try {
    const accounts = await listListenerAccounts();
    res.json({
      ok: true,
      enabled: config.baileysEnabled,
      runtime: getBaileysRuntimeStatus(),
      accounts
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/app-whatsapp-health", async (req, res, next) => {
  try {
    const phoneNumbers = Array.isArray(req.body?.phoneNumbers) ? req.body.phoneNumbers : [];
    const license = await checkAppLicense({
      deviceId: req.body?.deviceId || "",
      phoneNumbers
    });
    if (!license.allowed) {
      res.status(403).json({ ok: false, mode: license.mode, reason: license.reason, accounts: [] });
      return;
    }

    const normalizedPhones = new Set(phoneNumbers.map(normalizeHealthPhone).filter(Boolean));
    const runtime = getBaileysRuntimeStatus();
    const runtimeIds = new Set(runtime.map((item) => String(item.accountId)));
    const accounts = (await listListenerAccounts())
      .filter((account) => normalizedPhones.has(normalizeHealthPhone(account.phoneNumber)))
      .map((account) => ({
        accountKey: account.accountKey,
        displayName: account.displayName,
        phoneNumber: account.phoneNumber,
        lastStatus: account.lastStatus,
        listenEnabled: account.listenEnabled,
        testCaptureEnabled: account.testCaptureEnabled,
        connectedJid: account.connectedJid,
        lastSeenAt: account.lastSeenAt,
        runtimeActive: runtimeIds.has(String(account.id))
      }));

    res.json({ ok: true, accounts });
  } catch (error) {
    next(error);
  }
});

app.post("/api/app-support-summary", async (req, res, next) => {
  try {
    const phoneNumbers = Array.isArray(req.body?.phoneNumbers) ? req.body.phoneNumbers : [];
    const license = await checkAppLicense({
      deviceId: req.body?.deviceId || "",
      phoneNumbers
    });
    if (!license.allowed) {
      res.status(403).json({ ok: false, mode: license.mode, reason: license.reason, kpis: {} });
      return;
    }
    const normalizedPhones = new Set(phoneNumbers.map(normalizeHealthPhone).filter(Boolean));
    const account = (await listListenerAccounts())
      .find((item) => normalizedPhones.has(normalizeHealthPhone(item.phoneNumber)));
    if (!account) {
      res.json({ ok: true, kpis: {}, support: [], balances: [], agents: [] });
      return;
    }
    res.json({ ok: true, ...(await listSupportSummary({ accountId: account.id, limit: 50 })) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/baileys/accounts", async (req, res, next) => {
  try {
    const account = await upsertListenerAccount({
      accountKey: req.body?.accountKey,
      displayName: req.body?.displayName || "",
      phoneNumber: req.body?.phoneNumber || ""
    });
    res.status(201).json({
      ok: true,
      account,
      note: config.baileysEnabled
        ? "Restart the API to start this account listener."
        : "Account saved. Set BAILEYS_ENABLED=true and restart the API to start listening."
    });
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
  startBaileysListeners().catch((error) => {
    console.error("Baileys listener startup failed", error);
  });
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

function verifySignedRequest(req, res, next) {
  if (!config.apiRequestSecret) {
    next();
    return;
  }

  cleanupSignedRequestNonces();

  const timestamp = req.get("X-WA-Timestamp") || "";
  const nonce = req.get("X-WA-Nonce") || "";
  const signature = req.get("X-WA-Signature") || "";
  const timestampNumber = Number(timestamp);
  const now = Date.now();

  if (!timestamp || !nonce || !signature || !Number.isFinite(timestampNumber)) {
    res.status(401).json({ ok: false, errors: ["signed request headers are required"] });
    return;
  }
  if (Math.abs(now - timestampNumber) > SIGNATURE_WINDOW_MS) {
    res.status(401).json({ ok: false, errors: ["signed request timestamp expired"] });
    return;
  }

  const nonceKey = `${timestamp}:${nonce}`;
  if (seenSignedRequestNonces.has(nonceKey)) {
    res.status(401).json({ ok: false, errors: ["signed request nonce already used"] });
    return;
  }

  const rawBody = req.rawBody || "";
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const payload = [
    req.method.toUpperCase(),
    req.originalUrl,
    timestamp,
    nonce,
    bodyHash
  ].join("\n");
  const expected = crypto.createHmac("sha256", config.apiRequestSecret).update(payload).digest("hex");

  if (!timingSafeEqual(signature, expected)) {
    res.status(401).json({ ok: false, errors: ["invalid signed request"] });
    return;
  }

  seenSignedRequestNonces.set(nonceKey, timestampNumber);
  next();
}

function cleanupSignedRequestNonces() {
  const cutoff = Date.now() - SIGNATURE_WINDOW_MS;
  for (const [key, timestamp] of seenSignedRequestNonces.entries()) {
    if (timestamp < cutoff) {
      seenSignedRequestNonces.delete(key);
    }
  }
}

function normalizeHealthPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) {
    return "";
  }
  return digits.length > 10 && digits.startsWith("91") ? digits.slice(-10) : digits;
}

function timingSafeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual), "hex");
  const expectedBuffer = Buffer.from(String(expected), "hex");
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
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
