import express from "express";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { config } from "./config.js";
import { listCredits } from "./creditsRepository.js";
import { query } from "./db.js";
import {
  deleteInboundWhatsappMessage,
  getListenerAccountById,
  listForwardTargets,
  listBookingStats,
  listSupportSummary,
  listInboundWhatsappMessages,
  listListenerEvents,
  listListenerAccounts,
  listWhatsappPaymentProofs,
  setTestCaptureEnabled,
  upsertForwardTarget,
  upsertListenerAccount
} from "./baileysRepository.js";
import {
  getBaileysRuntimeStatus,
  listBaileysChats,
  startBaileysAccount,
  stopBaileysAccount
} from "./baileysService.js";

export const adminDashboardRouter = express.Router();

const SESSION_COOKIE = "wa_admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

adminDashboardRouter.post("/login", (req, res) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  const totp = String(req.body?.totp || "");

  if (!isAdminConfigured()) {
    res.status(503).json({ ok: false, error: "Admin login is not configured." });
    return;
  }
  if (!timingSafeText(username, config.adminUsername) || !timingSafeText(password, config.adminPassword)) {
    res.status(401).json({ ok: false, error: "Invalid username or password." });
    return;
  }
  if (config.adminTotpSecret && !verifyTotp(config.adminTotpSecret, totp)) {
    res.status(401).json({ ok: false, error: "Invalid authenticator code." });
    return;
  }

  setSessionCookie(req, res, username);
  res.json({ ok: true, username, totpEnabled: Boolean(config.adminTotpSecret) });
});

adminDashboardRouter.post("/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0`);
  res.json({ ok: true });
});

adminDashboardRouter.get("/session", (req, res) => {
  const session = readSession(req);
  res.json({
    ok: true,
    configured: isAdminConfigured(),
    authenticated: Boolean(session),
    username: session?.username || "",
    totpEnabled: Boolean(config.adminTotpSecret)
  });
});

adminDashboardRouter.use(requireAdminSession);

adminDashboardRouter.get("/status", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      baileysEnabled: config.baileysEnabled,
      runtime: getBaileysRuntimeStatus()
    });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.get("/accounts", async (_req, res, next) => {
  try {
    res.json({ ok: true, accounts: await listListenerAccounts() });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.post("/accounts", async (req, res, next) => {
  try {
    const account = await upsertListenerAccount({
      accountKey: req.body?.accountKey,
      displayName: req.body?.displayName || "",
      phoneNumber: req.body?.phoneNumber || ""
    });
    res.status(201).json({ ok: true, account });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.post("/accounts/:id/start", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await startBaileysAccount(Number(req.params.id))) });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.post("/accounts/:id/stop", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await stopBaileysAccount(Number(req.params.id))) });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.post("/accounts/:id/test-capture", async (req, res, next) => {
  try {
    const account = await setTestCaptureEnabled(Number(req.params.id), Boolean(req.body?.enabled));
    res.json({ ok: true, account });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.get("/accounts/:id/qr", async (req, res, next) => {
  try {
    const account = await getListenerAccountById(Number(req.params.id));
    if (!account?.latestQr) {
      res.status(404).json({ ok: false, error: "QR not ready. Start the listener and wait a few seconds." });
      return;
    }
    res.json({
      ok: true,
      qr: account.latestQr,
      dataUrl: await QRCode.toDataURL(account.latestQr, { margin: 1, width: 320 })
    });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.get("/accounts/:id/chats", async (req, res, next) => {
  try {
    res.json({
      ok: true,
      chats: await listBaileysChats(Number(req.params.id), {
        refresh: String(req.query.refresh || "") === "1",
        query: String(req.query.q || "")
      })
    });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.get("/bookings", async (req, res, next) => {
  try {
    res.json({
      ok: true,
      bookings: await listInboundWhatsappMessages({
        accountId: Number(req.query.accountId || 0),
        showCode: String(req.query.showCode || ""),
        limit: Number(req.query.limit || 100)
      })
    });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.get("/booking-stats", async (req, res, next) => {
  try {
    res.json({
      ok: true,
      stats: await listBookingStats({ days: Number(req.query.days || 14) })
    });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.get("/support-summary", async (req, res, next) => {
  try {
    res.json({
      ok: true,
      ...(await listSupportSummary({
        accountId: Number(req.query.accountId || 0),
        limit: Number(req.query.limit || 200)
      }))
    });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.delete("/bookings/:id", async (req, res, next) => {
  try {
    const deleted = await deleteInboundWhatsappMessage(Number(req.params.id));
    res.json({ ok: true, deleted });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.get("/listener-events", async (req, res, next) => {
  try {
    res.json({
      ok: true,
      events: await listListenerEvents({
        accountId: Number(req.query.accountId || 0),
        limit: Number(req.query.limit || 100)
      })
    });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.get("/payment-proofs", async (req, res, next) => {
  try {
    res.json({
      ok: true,
      proofs: await listWhatsappPaymentProofs({
        accountId: Number(req.query.accountId || 0),
        limit: Number(req.query.limit || 100)
      })
    });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.get("/forward-targets", async (_req, res, next) => {
  try {
    res.json({ ok: true, targets: await listForwardTargets() });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.put("/forward-targets/:showCode", async (req, res, next) => {
  try {
    const target = await upsertForwardTarget({
      showCode: req.params.showCode,
      destinationJid: req.body?.destinationJid || "",
      label: req.body?.label || "",
      isEnabled: Boolean(req.body?.isEnabled)
    });
    res.json({ ok: true, target });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.get("/credits", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit || 100);
    res.json({ ok: true, credits: await listCredits(limit) });
  } catch (error) {
    next(error);
  }
});

adminDashboardRouter.delete("/credits/:id", async (req, res, next) => {
  try {
    const result = await query("DELETE FROM bank_credit_messages WHERE id = $1 RETURNING id", [Number(req.params.id)]);
    res.json({ ok: true, deleted: result.rows[0] || null });
  } catch (error) {
    next(error);
  }
});

function requireAdminSession(req, res, next) {
  if (!isAdminConfigured()) {
    res.status(503).json({ ok: false, error: "Admin login is not configured." });
    return;
  }
  const session = readSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: "Admin login required" });
    return;
  }
  next();
}

function isAdminConfigured() {
  return Boolean(config.adminUsername && config.adminPassword && sessionSecret());
}

function sessionSecret() {
  return config.adminSessionSecret || config.adminPassword;
}

function setSessionCookie(req, res, username) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ username, expiresAt })).toString("base64url");
  const signature = sign(payload);
  const crossSite = Boolean(config.adminCorsOrigin) || isCrossOriginAdminRequest(req);
  const sameSite = crossSite ? "None" : "Lax";
  const secure = crossSite ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${payload}.${signature}; HttpOnly; SameSite=${sameSite}; Path=/admin; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`
  );
}

function isCrossOriginAdminRequest(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) {
    return false;
  }
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  if (!host) {
    return true;
  }
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

function readSession(req) {
  const cookie = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  if (!cookie) {
    return null;
  }
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature || !timingSafeText(signature, sign(payload))) {
    return null;
  }
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.expiresAt || session.expiresAt < Date.now()) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function timingSafeText(actual, expected) {
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function verifyTotp(secret, token) {
  const digits = String(token || "").replace(/\D/g, "");
  if (digits.length !== 6) {
    return false;
  }
  const step = Math.floor(Date.now() / 30_000);
  return [step - 1, step, step + 1].some((counter) => timingSafeText(generateTotp(secret, counter), digits));
}

function generateTotp(secret, counter) {
  const key = decodeBase32(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = String(value || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of cleaned) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      continue;
    }
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}
