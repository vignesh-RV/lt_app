import fs from "node:fs/promises";
import path from "node:path";
import makeWASocket, {
  DisconnectReason,
  downloadContentFromMessage,
  useMultiFileAuthState
} from "baileys";
import pino from "pino";
import { config } from "./config.js";
import {
  getListenerAccountById,
  findForwardableBookingForProof,
  listWhatsappChats,
  listListenerAccounts,
  markBookingForwarded,
  markPaymentProofForwardResult,
  setListenerEnabled,
  storeInboundWhatsappMessage,
  storeListenerEvent,
  storeWhatsappPaymentProof,
  upsertWhatsappChat,
  updateListenerAccountStatus
} from "./baileysRepository.js";
import { calculatePredictionPricing } from "./gamePricing.js";
import { readImageText } from "./ocrService.js";
import { parsePaymentProofText } from "./paymentProofParser.js";
import { activeBookingWindow } from "./showSchedule.js";
import { findCreditForProof } from "./workflowRepository.js";

const sockets = new Map();
const chatCache = new Map();
const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || "warn" });

export async function startBaileysListeners() {
  if (!config.baileysEnabled) {
    console.log("Baileys listener disabled. Set BAILEYS_ENABLED=true to start.");
    return;
  }

  await fs.mkdir(config.baileysAuthDir, { recursive: true });
  const accounts = await listListenerAccounts({ activeOnly: true });
  for (const account of accounts) {
    startAccountSocket(account).catch((error) => {
      console.error(`Baileys start failed for ${account.accountKey}`, error);
    });
  }
}

export function getBaileysRuntimeStatus() {
  return [...sockets.values()].map((item) => ({
    accountId: Number(item.account.id),
    accountKey: item.account.accountKey,
    startedAt: item.startedAt
  }));
}

export async function startBaileysAccount(accountId) {
  const account = await getListenerAccountById(accountId);
  if (!account) {
    throw new Error("WhatsApp account not found");
  }
  await setListenerEnabled(account.id, true);
  await startAccountSocket(account);
  return { started: true, accountId: account.id, accountKey: account.accountKey };
}

export async function stopBaileysAccount(accountId) {
  await setListenerEnabled(accountId, false);
  const running = sockets.get(Number(accountId));
  if (running?.socket) {
    try {
      running.socket.end(undefined);
    } catch {
      // Socket may already be closed.
    }
  }
  sockets.delete(Number(accountId));
  await updateListenerAccountStatus(accountId, { status: "stopped_by_admin", qr: "" });
  return { stopped: true, accountId: Number(accountId) };
}

export async function listBaileysChats(accountId, { refresh = false, query = "" } = {}) {
  const storedChats = await listWhatsappChats({ accountId: Number(accountId), search: query, limit: 300 });
  let running = null;
  try {
    running = await ensureConnectedSocket(accountId);
    if (refresh) {
      try {
        await refreshAccountChats(running.account, running.socket);
      } catch (error) {
        await storeListenerEvent({
          account: running.account,
          eventType: "chat_sync_failed",
          detail: error.message || "Failed to refresh chats"
        });
      }
    }
  } catch (error) {
    if (!storedChats.length) {
      throw error;
    }
  }
  const needle = String(query || "").trim().toLowerCase();
  const runtimeChats = [...getAccountChatMap(accountId).values()]
    .filter((chat) => !needle
      || chat.jid.toLowerCase().includes(needle)
      || chat.name.toLowerCase().includes(needle)
      || chat.type.toLowerCase().includes(needle))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "group" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 300);
  return mergeChats([...runtimeChats, ...storedChats]);
}

async function startAccountSocket(account) {
  const accountId = socketKey(account.id);
  if (sockets.has(accountId)) {
    return;
  }

  const authDir = path.join(config.baileysAuthDir, account.accountKey);
  await fs.mkdir(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const socket = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false
  });

  sockets.set(accountId, { account, socket, startedAt: new Date().toISOString(), connected: false });
  await updateListenerAccountStatus(account.id, { status: "starting" });

  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("connection.update", async (update) => {
    if (update.qr) {
      await updateListenerAccountStatus(account.id, { status: "qr_ready", qr: update.qr });
    }
    if (update.connection === "open") {
      const running = sockets.get(accountId);
      if (running) {
        running.connected = true;
        running.account = account;
      }
      await updateListenerAccountStatus(account.id, {
        status: "connected",
        qr: "",
        connectedJid: socket.user?.id || ""
      });
      refreshAccountChats(account, socket).catch((error) => {
        storeListenerEvent({
          account,
          eventType: "chat_sync_failed",
          detail: error.message || "Failed to load chats"
        }).catch(() => {});
      });
    }
    if (update.connection === "close") {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      sockets.delete(accountId);
      await updateListenerAccountStatus(account.id, {
        status: shouldReconnect ? "disconnected_retrying" : "logged_out",
        error: update.lastDisconnect?.error?.message || ""
      });
      if (shouldReconnect) {
        setTimeout(() => startAccountSocket(account).catch(console.error), 10_000);
      }
    }
  });

  socket.ev.on("messages.upsert", async (event) => {
    await storeListenerEvent({
      account,
      eventType: "messages.upsert",
      detail: `type=${event.type}; count=${event.messages?.length || 0}`
    });
    if (event.type !== "notify") {
      return;
    }
    for (const message of event.messages || []) {
      await persistChat(account, {
        jid: message.key?.remoteJid || "",
        name: message.pushName || "",
        type: jidType(message.key?.remoteJid || ""),
        source: "message"
      });
      await captureMessageIfInWindow(account, message);
    }
  });

  socket.ev.on("chats.upsert", (chats) => {
    for (const chat of chats || []) {
      persistChat(account, {
        jid: chat.id,
        name: chat.name || chat.subject || chat.id,
        type: jidType(chat.id),
        source: "chat"
      }).catch(() => {});
    }
  });

  socket.ev.on("contacts.upsert", (contacts) => updateContactChats(account, contacts));
  socket.ev.on("contacts.update", (contacts) => updateContactChats(account, contacts));
}

async function ensureConnectedSocket(accountId) {
  let running = sockets.get(Number(accountId));
  if (isSocketConnected(running)) {
    return running;
  }

  if (!running?.socket) {
    const account = await getListenerAccountById(accountId);
    if (!account) {
      throw new Error("WhatsApp account not found.");
    }
    await setListenerEnabled(account.id, true);
    await startAccountSocket(account);
  }

  running = await waitForConnectedSocket(accountId, 10_000);
  if (!isSocketConnected(running)) {
    throw new Error("Listener is starting. Wait a few seconds and click Load chats again.");
  }
  return running;
}

async function waitForConnectedSocket(accountId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const running = sockets.get(Number(accountId));
    if (isSocketConnected(running)) {
      return running;
    }
    await wait(350);
  }
  return sockets.get(Number(accountId)) || null;
}

function isSocketConnected(running) {
  if (!running?.socket) {
    return false;
  }
  if (running.connected || running.socket.user?.id) {
    running.connected = true;
    return true;
  }
  return false;
}

async function refreshAccountChats(account, socket) {
  const groups = await socket.groupFetchAllParticipating();
  for (const group of Object.values(groups || {})) {
    await persistChat(account, {
      jid: group.id,
      name: group.subject || group.name || group.id,
      type: "group",
      source: "group"
    });
  }
  await storeListenerEvent({
    account,
    eventType: "chat_sync_complete",
    detail: `groups=${Object.keys(groups || {}).length}; cached=${getAccountChatMap(account.id).size}`
  });
}

function updateContactChats(account, contacts = []) {
  for (const contact of contacts || []) {
    persistChat(account, {
      jid: contact.id,
      name: contact.name || contact.notify || contact.verifiedName || contact.id,
      type: jidType(contact.id),
      source: "contact"
    }).catch(() => {});
  }
}

function upsertChat(accountId, chat) {
  if (!chat?.jid || chat.jid === "status@broadcast") {
    return;
  }
  const map = getAccountChatMap(accountId);
  const existing = map.get(chat.jid) || {};
  map.set(chat.jid, {
    jid: chat.jid,
    name: chat.name || existing.name || chat.jid,
    type: chat.type || existing.type || jidType(chat.jid),
    source: chat.source || existing.source || "runtime",
    updatedAt: new Date().toISOString()
  });
}

async function persistChat(account, chat) {
  upsertChat(account.id, chat);
  await upsertWhatsappChat({
    account,
    jid: chat.jid,
    displayName: chat.name,
    chatType: chat.type || jidType(chat.jid),
    source: chat.source || "runtime"
  }).catch(() => {});
}

function mergeChats(chats) {
  const map = new Map();
  for (const chat of chats) {
    if (!chat?.jid) continue;
    const existing = map.get(chat.jid) || {};
    map.set(chat.jid, {
      jid: chat.jid,
      name: chat.name || existing.name || chat.jid,
      type: chat.type || existing.type || jidType(chat.jid),
      source: chat.source || existing.source || "",
      updatedAt: chat.updatedAt || existing.updatedAt || ""
    });
  }
  return [...map.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === "group" ? -1 : 1;
    return a.name.localeCompare(b.name);
  }).slice(0, 300);
}

function getAccountChatMap(accountId) {
  const key = Number(accountId);
  if (!chatCache.has(key)) {
    chatCache.set(key, new Map());
  }
  return chatCache.get(key);
}

function jidType(jid) {
  if (/@g\.us$/i.test(String(jid || ""))) {
    return "group";
  }
  return "chat";
}

async function captureMessageIfInWindow(account, message) {
  if (!message?.key?.id || message.key.fromMe) {
    await storeListenerEvent({
      account,
      eventType: "message_skipped",
      detail: message?.key?.fromMe ? "fromMe message ignored" : "message id missing"
    });
    return;
  }

  const receivedAt = message.messageTimestamp
    ? new Date(Number(message.messageTimestamp) * 1000)
    : new Date();
  const window = activeBookingWindow(receivedAt);
  if (!window.active && !account.testCaptureEnabled) {
    await storeListenerEvent({
      account,
      eventType: "message_skipped",
      detail: "outside booking window and test capture is off",
      messageId: message.key.id,
      remoteJid: message.key.remoteJid || "",
      senderJid: message.key.participant || message.key.remoteJid || ""
    });
    return;
  }

  if (hasPaymentProofMedia(message.message)) {
    await capturePaymentProofMedia(account, message, receivedAt, window);
    return;
  }

  const messageText = extractMessageText(message.message);
  if (!messageText) {
    await storeListenerEvent({
      account,
      eventType: "message_skipped",
      detail: "no text/caption found",
      messageId: message.key.id,
      remoteJid: message.key.remoteJid || "",
      senderJid: message.key.participant || message.key.remoteJid || ""
    });
    return;
  }

  let pricing = null;
  try {
    pricing = await calculatePredictionPricing(messageText, receivedAt);
  } catch (error) {
    await storeListenerEvent({
      account,
      eventType: "pricing_failed",
      detail: error.message || "pricing failed",
      messageId: message.key.id,
      remoteJid: message.key.remoteJid || "",
      senderJid: message.key.participant || message.key.remoteJid || "",
      messageText
    });
  }

  await storeInboundWhatsappMessage({
    account,
    messageId: message.key.id,
    remoteJid: message.key.remoteJid || "",
    senderJid: message.key.participant || message.key.remoteJid || "",
    pushName: message.pushName || "",
    messageText,
    messageJson: message,
    showCode: window.active ? window.showCode : "TEST_CAPTURE",
    listenerWindow: account.testCaptureEnabled && !window.active
      ? { ...window, active: true, showCode: "TEST_CAPTURE", testCapture: true }
      : window,
    pricing,
    receivedAt
  });
  await storeListenerEvent({
    account,
    eventType: "message_captured",
    detail: window.active ? `captured for ${window.showCode}` : "captured by test mode",
    messageId: message.key.id,
    remoteJid: message.key.remoteJid || "",
    senderJid: message.key.participant || message.key.remoteJid || "",
    messageText
  });
}

async function capturePaymentProofMedia(account, message, receivedAt, window) {
  const media = getSupportedMedia(message.message);
  const messageId = message.key.id;
  const remoteJid = message.key.remoteJid || "";
  const senderJid = message.key.participant || remoteJid;
  const mediaDir = path.join("uploads", "baileys-payment-proofs", account.accountKey);
  await fs.mkdir(mediaDir, { recursive: true });
  const extension = media.type === "document" ? documentExtension(media.content) : "jpg";
  const filePath = path.join(mediaDir, `${messageId}.${extension}`);

  try {
    await writeMediaToFile(media.content, media.downloadType, filePath);
    const ocrText = await readImageText(filePath);
    const proof = parsePaymentProofText(ocrText);
    const reference = proof.uniqueReference || proof.transactionId || proof.utr || "";
    const matchedCredit = proof.amount || reference
      ? await findCreditForProof({ transactionId: reference, amount: proof.amount || null })
      : null;
    const status = matchedCredit
      ? (proof.amount && Number(matchedCredit.amount) !== Number(proof.amount) ? "amount_mismatch" : "matched")
      : "not_found";
    const paymentProof = await storeWhatsappPaymentProof({
      account,
      messageId,
      remoteJid,
      senderJid,
      pushName: message.pushName || "",
      mediaType: media.type,
      filePath,
      ocrText,
      proof,
      status,
      matchedCreditId: matchedCredit?.id || null,
      receivedAt
    });
    if (status === "matched" && paymentProof?.id) {
      await forwardPaidBooking({
        account,
        paymentProofId: paymentProof.id,
        remoteJid,
        senderJid,
        amount: proof.amount || matchedCredit.amount,
        receivedAt
      });
    }
    await storeListenerEvent({
      account,
      eventType: "payment_proof_parsed",
      detail: `status=${status}; amount=${proof.amount || "-"}; ref=${reference || "-"}; credit=${matchedCredit?.id || "-"}`,
      messageId,
      remoteJid,
      senderJid,
      messageText: ocrText
    });
  } catch (error) {
    await storeWhatsappPaymentProof({
      account,
      messageId,
      remoteJid,
      senderJid,
      pushName: message.pushName || "",
      mediaType: media.type,
      filePath,
      ocrText: "",
      proof: { error: error.message || "OCR failed" },
      status: "ocr_failed",
      receivedAt
    });
    await storeListenerEvent({
      account,
      eventType: "payment_proof_failed",
      detail: error.message || "OCR failed",
      messageId,
      remoteJid,
      senderJid
    });
  }
}

async function forwardPaidBooking({ account, paymentProofId, remoteJid, senderJid, amount, receivedAt }) {
  const booking = await findForwardableBookingForProof({
    accountId: account.id,
    remoteJid,
    senderJid,
    amount,
    receivedAt
  });
  if (!booking) {
    await markPaymentProofForwardResult({
      proofId: paymentProofId,
      error: "No priced pending booking found for sender/show/amount or forwarding target is not configured"
    });
    await storeListenerEvent({
      account,
      eventType: "booking_forward_skipped",
      detail: "No priced pending booking found for sender/show/amount or forwarding target is not configured",
      remoteJid,
      senderJid
    });
    return;
  }

  const destinationJid = normalizeDestinationJid(booking.destinationJid);
  const running = sockets.get(Number(account.id));
  if (!running?.socket) {
    const error = "WhatsApp socket is not running for this account";
    await markPaymentProofForwardResult({ proofId: paymentProofId, bookingId: booking.id, error });
    await storeListenerEvent({
      account,
      eventType: "booking_forward_failed",
      detail: error,
      remoteJid,
      senderJid,
      messageText: booking.messageText
    });
    return;
  }

  try {
    await running.socket.sendMessage(destinationJid, { text: booking.messageText });
    await markBookingForwarded({ bookingId: booking.id, paymentProofId, destinationJid });
    await markPaymentProofForwardResult({ proofId: paymentProofId, bookingId: booking.id, forwarded: true });
    await storeListenerEvent({
      account,
      eventType: "booking_forwarded",
      detail: `booking=${booking.id}; show=${booking.showCode}; to=${destinationJid}`,
      remoteJid,
      senderJid,
      messageText: booking.messageText
    });
  } catch (error) {
    await markPaymentProofForwardResult({
      proofId: paymentProofId,
      bookingId: booking.id,
      error: error.message || "Forward failed"
    });
    await storeListenerEvent({
      account,
      eventType: "booking_forward_failed",
      detail: error.message || "Forward failed",
      remoteJid,
      senderJid,
      messageText: booking.messageText
    });
  }
}

function hasPaymentProofMedia(message = {}) {
  return Boolean(getSupportedMedia(message));
}

function getSupportedMedia(message = {}) {
  if (message.imageMessage) {
    return { type: "image", content: message.imageMessage, downloadType: "image" };
  }
  if (message.documentMessage && /^image\//i.test(message.documentMessage.mimetype || "")) {
    return { type: "document", content: message.documentMessage, downloadType: "document" };
  }
  return null;
}

async function writeMediaToFile(content, mediaType, filePath) {
  const stream = await downloadContentFromMessage(content, mediaType);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  await fs.writeFile(filePath, Buffer.concat(chunks));
}

function documentExtension(content) {
  const mimetype = String(content?.mimetype || "").toLowerCase();
  if (mimetype.includes("png")) return "png";
  if (mimetype.includes("webp")) return "webp";
  return "jpg";
}

function normalizeDestinationJid(value) {
  const text = String(value || "").trim();
  if (/@(s\.whatsapp\.net|g\.us)$/i.test(text)) {
    return text;
  }
  const digits = text.replace(/\D/g, "");
  if (digits) {
    return `${digits}@s.whatsapp.net`;
  }
  return text;
}

function socketKey(accountId) {
  return Number(accountId);
}

function extractMessageText(message = {}) {
  return message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || "";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
