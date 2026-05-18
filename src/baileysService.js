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
  addCustomerPaymentBalance,
  getListenerAccountById,
  getCustomerPaymentBalance,
  getInboundWhatsappMessageById,
  listForwardableBookingsForProof,
  listWhatsappChats,
  listListenerAccounts,
  markBookingForwarded,
  markPaymentProofForwardResult,
  setListenerEnabled,
  storeInboundWhatsappMessage,
  storeListenerEvent,
  storeWhatsappPaymentProof,
  setCustomerPaymentBalance,
  updateInboundWhatsappPricing,
  upsertWhatsappChat,
  updateListenerAccountStatus
} from "./baileysRepository.js";
import { calculatePredictionPricing } from "./gamePricing.js";
import { readImageText } from "./ocrService.js";
import { parsePaymentProofText } from "./paymentProofParser.js";
import { activeBookingWindow, isShowWindowActive } from "./showSchedule.js";
import { findCreditForProof } from "./workflowRepository.js";
import { logError, logInfo } from "./logger.js";

const sockets = new Map();
const chatCache = new Map();
const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || "warn" });
let outboundReplyQueue = Promise.resolve();
const CARRIED_BALANCE_SHOW = "__BALANCE__";

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

export async function retryManualBooking(bookingId) {
  const booking = await getInboundWhatsappMessageById(bookingId);
  if (!booking) {
    throw new Error("Booking not found");
  }
  const account = await getListenerAccountById(booking.accountId);
  if (!account) {
    throw new Error("WhatsApp account not found");
  }
  const activeWindow = activeBookingWindow(new Date());
  if (booking.showCode !== "TEST_CAPTURE" && (!activeWindow.active || activeWindow.showCode !== booking.showCode)) {
    const reason = activeWindow.active
      ? `Booking window closed for ${booking.showCode}. Current active window is ${activeWindow.showCode}.`
      : `Booking window closed for ${booking.showCode}. No booking window is active now.`;
    await storeListenerEvent({
      account,
      eventType: "manual_retry_blocked",
      detail: reason,
      messageId: booking.messageId || "",
      remoteJid: booking.remoteJid || "",
      senderJid: booking.senderJid || "",
      messageText: booking.messageText || ""
    });
    const error = new Error(reason);
    error.statusCode = 409;
    throw error;
  }
  const receivedAt = booking.receivedAt ? new Date(booking.receivedAt) : new Date();
  const pricing = await calculatePredictionPricing(booking.messageText || "", receivedAt);
  if (!pricing) {
    throw new Error("Pricing could not be calculated");
  }
  const updated = await updateInboundWhatsappPricing(booking.id, pricing);
  await storeListenerEvent({
    account,
    eventType: pricing.manualWork ? "manual_retry_still_manual" : "manual_retry_priced",
    detail: pricing.manualWork
      ? pricing.breakdown?.reason || "still requires manual support"
      : `amount=${pricing.totalPrice}`,
    messageId: booking.messageId || "",
    remoteJid: booking.remoteJid || "",
    senderJid: booking.senderJid || "",
    messageText: booking.messageText || ""
  });

  if (isAutoReplyPricing(pricing)) {
    const message = storedBookingToBaileysMessage(booking);
    await enqueueOutboundReply(async () => {
      await sendPricingReply(account, message, booking.messageText || "", pricing);
      await applyCarriedBalanceForBooking({
        account,
        message,
        pricing,
        window: booking.listenerWindow || {},
        receivedAt
      });
    });
  }

  return { booking: updated, pricing };
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
  const latestAccount = await getListenerAccountById(account.id);
  if (!latestAccount?.isActive) {
    return;
  }
  account = latestAccount;
  const running = sockets.get(socketKey(account.id));
  if (running) {
    running.account = account;
  }

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
  const messageText = extractMessageText(message.message);
  const window = activeBookingWindow(receivedAt);
  if (!window.active && !account.testCaptureEnabled) {
    await storeListenerEvent({
      account,
      eventType: "message_skipped",
      detail: "outside booking window and test capture is off",
      messageId: message.key.id,
      remoteJid: message.key.remoteJid || "",
      senderJid: message.key.participant || message.key.remoteJid || "",
      messageText: messageText || mediaMessageLabel(message.message)
    });
    await markIncomingMessageRead(account, message);
    return;
  }

  if (hasPaymentProofMedia(message.message)) {
    await capturePaymentProofMedia(account, message, receivedAt, window);
    return;
  }

  if (!messageText) {
    await storeListenerEvent({
      account,
      eventType: "message_skipped",
      detail: "no text/caption found",
      messageId: message.key.id,
      remoteJid: message.key.remoteJid || "",
      senderJid: message.key.participant || message.key.remoteJid || "",
      messageText: mediaMessageLabel(message.message)
    });
    await markIncomingMessageRead(account, message);
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

  const storedMessage = await storeInboundWhatsappMessage({
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
  await markIncomingMessageRead(account, message);

  if (storedMessage && isAutoReplyPricing(pricing)) {
    await enqueueOutboundReply(async () => {
      await sendPricingReply(account, message, messageText, pricing);
      await applyCarriedBalanceForBooking({ account, message, pricing, window, receivedAt });
    });
  }
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
    logInfo("payment_proof_capture_start", {
      accountId: account.id,
      accountKey: account.accountKey,
      messageId,
      remoteJid,
      senderJid,
      mediaType: media.type,
      filePath
    });
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
    logInfo("payment_proof_capture_success", {
      accountId: account.id,
      accountKey: account.accountKey,
      messageId,
      status,
      amount: proof.amount || "",
      reference: reference || "",
      matchedCreditId: matchedCredit?.id || ""
    });
    await markIncomingMessageRead(account, message);
  } catch (error) {
    logError("payment_proof_capture_failed", error, {
      accountId: account.id,
      accountKey: account.accountKey,
      messageId,
      remoteJid,
      senderJid,
      mediaType: media.type,
      filePath
    });
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
    await markIncomingMessageRead(account, message);
  }
}

function isAutoReplyPricing(pricing) {
  return Boolean(pricing && !pricing.manualWork && pricing.totalPrice && pricing.breakdown?.entries?.length);
}

async function applyCarriedBalanceForBooking({ account, message, pricing, window, receivedAt }) {
  if (!window.active || !pricing?.totalPrice) {
    return;
  }
  const remoteJid = message.key?.remoteJid || "";
  const senderJid = message.key?.participant || remoteJid;
  const carriedBalance = await getCustomerPaymentBalance({
    accountId: account.id,
    remoteJid,
    senderJid,
    showCode: CARRIED_BALANCE_SHOW
  });
  if (carriedBalance <= 0) {
    return;
  }

  const bookingAmount = Number(pricing.totalPrice || 0);
  const currentShowBalance = await getCustomerPaymentBalance({
    accountId: account.id,
    remoteJid,
    senderJid,
    showCode: window.showCode
  });
  const useAmount = Math.min(carriedBalance, Math.max(bookingAmount - currentShowBalance, 0));
  if (useAmount <= 0) {
    return;
  }

  await setCustomerPaymentBalance({
    accountId: account.id,
    remoteJid,
    senderJid,
    showCode: CARRIED_BALANCE_SHOW,
    balance: carriedBalance - useAmount
  });
  const availableAmount = await addCustomerPaymentBalance({
    accountId: account.id,
    remoteJid,
    senderJid,
    showCode: window.showCode,
    amount: useAmount
  });

  const running = sockets.get(Number(account.id));
  if (!running?.socket) {
    return;
  }
  if (availableAmount >= bookingAmount) {
    await forwardPaidBooking({ account, paymentProofId: null, remoteJid, senderJid, amount: 0, receivedAt });
  } else {
    await sendPendingDetails({
      account,
      socket: running.socket,
      remoteJid,
      senderJid,
      pendingAmount: bookingAmount - availableAmount
    });
  }
}

async function enqueueOutboundReply(task) {
  const queued = outboundReplyQueue
    .catch(() => {})
    .then(task);
  outboundReplyQueue = queued.catch(() => {});
  return queued;
}

async function sendPricingReply(account, message, originalText, pricing) {
  const remoteJid = message.key?.remoteJid || "";
  if (!remoteJid) {
    return;
  }

  const running = sockets.get(Number(account.id));
  if (!isSocketConnected(running)) {
    await storeListenerEvent({
      account,
      eventType: "pricing_reply_skipped",
      detail: "socket not connected",
      messageId: message.key?.id || "",
      remoteJid,
      senderJid: message.key?.participant || remoteJid
    });
    return;
  }

  const replyText = buildPricingReplyMessage(pricing);
  const delayMs = typingDelayForMessage(originalText);
  const quoted = quotedPredictionMessage(message);
  try {
    await waitWithTyping(running.socket, remoteJid, delayMs);
    await running.socket.sendMessage(remoteJid, { text: replyText }, quoted ? { quoted } : undefined);
    await running.socket.sendPresenceUpdate("paused", remoteJid);
    await storeListenerEvent({
      account,
      eventType: "pricing_reply_sent",
      detail: `delay=${delayMs}ms; amount=${pricing.totalPrice}; quoted=${quoted ? "yes" : "no"}`,
      messageId: message.key?.id || "",
      remoteJid,
      senderJid: message.key?.participant || remoteJid,
      messageText: replyText
    });
  } catch (error) {
    try {
      await running.socket.sendPresenceUpdate("paused", remoteJid);
    } catch {
      // Presence cleanup is best-effort.
    }
    await storeListenerEvent({
      account,
      eventType: "pricing_reply_failed",
      detail: error.message || "reply failed",
      messageId: message.key?.id || "",
      remoteJid,
      senderJid: message.key?.participant || remoteJid,
      messageText: replyText
    });
  }
}

function quotedPredictionMessage(message) {
  if (!message?.key || !message.message) {
    return null;
  }
  return {
    key: message.key,
    message: message.message,
    pushName: message.pushName || ""
  };
}

function storedBookingToBaileysMessage(booking) {
  const stored = booking.messageJson || {};
  if (stored?.key && stored?.message) {
    return stored;
  }
  return {
    key: {
      id: booking.messageId || "",
      remoteJid: booking.remoteJid || "",
      participant: booking.senderJid || undefined,
      fromMe: false
    },
    message: {
      conversation: booking.messageText || ""
    },
    pushName: booking.pushName || ""
  };
}

function buildPricingReplyMessage(pricing) {
  const lines = (pricing.breakdown?.entries || []).map((entry) =>
    `${replyEntryLabel(entry)} = r${replyMoney(entry.lineTotal)}`
  );
  lines.push("");
  lines.push(`T = r${replyMoney(pricing.totalPrice)}`);
  return lines.join("\n");
}

function replyEntryLabel(entry) {
  const mode = entry.gameMode || "";
  const number = entry.originalNumber || entry.normalizedNumber || "";
  let label = "";
  if (mode === "DIRECT") {
    label = number;
  } else if (mode === "BOX") {
    label = `${number} bx`;
  } else {
    label = `${mode}${number}`;
  }

  if (entry.expansionCount > 1 && mode !== "BOX") {
    label += ` ${entry.units} units`;
  } else {
    label += ` ${entry.setCount || 1}s`;
  }

  if (Number(entry.unitPrice) !== 12) {
    label += ` r${replyMoney(entry.unitPrice)}`;
  }
  return label.trim();
}

function replyMoney(value) {
  return String(Math.round(Number(value || 0)));
}

function typingDelayForMessage(text) {
  const chars = String(text || "").length;
  const randomMs = 800 + Math.floor(Math.random() * 3400);
  return Math.min(Math.max(1600 + chars * 55 + randomMs, 2500), 30000);
}

async function waitWithTyping(socket, remoteJid, delayMs) {
  let remaining = delayMs;
  while (remaining > 0) {
    await socket.sendPresenceUpdate("composing", remoteJid);
    const chunk = Math.min(remaining, 8000);
    await wait(chunk);
    remaining -= chunk;
  }
}

async function markIncomingMessageRead(account, message) {
  if (!message?.key?.id || !message.key.remoteJid) {
    return;
  }
  const running = sockets.get(Number(account.id));
  if (!isSocketConnected(running) || typeof running.socket.readMessages !== "function") {
    return;
  }
  try {
    await running.socket.readMessages([message.key]);
    await storeListenerEvent({
      account,
      eventType: "message_marked_read",
      detail: "read receipt sent",
      messageId: message.key.id,
      remoteJid: message.key.remoteJid || "",
      senderJid: message.key.participant || message.key.remoteJid || ""
    });
  } catch (error) {
    await storeListenerEvent({
      account,
      eventType: "message_mark_read_failed",
      detail: error.message || "failed to mark message read",
      messageId: message.key.id,
      remoteJid: message.key.remoteJid || "",
      senderJid: message.key.participant || message.key.remoteJid || ""
    });
  }
}

async function forwardPaidBooking({ account, paymentProofId, remoteJid, senderJid, amount, receivedAt }) {
  const paymentAmount = Number(amount || 0);
  const paymentWindow = activeBookingWindow(receivedAt);
  if (!paymentWindow.active) {
    await addCustomerPaymentBalance({
      accountId: account.id,
      remoteJid,
      senderJid,
      showCode: CARRIED_BALANCE_SHOW,
      amount: paymentAmount,
      paymentProofId
    });
    const running = sockets.get(Number(account.id));
    if (running?.socket) {
      await sendTimesUpMessage({ account, socket: running.socket, remoteJid, senderJid, balance: paymentAmount });
    }
    await markPaymentProofForwardResult({
      proofId: paymentProofId,
      error: "Times Up - payment received outside active booking window"
    });
    await storeListenerEvent({
      account,
      eventType: "booking_forward_skipped",
      detail: "Times Up - payment received outside active booking window",
      remoteJid,
      senderJid
    });
    return;
  }

  const carriedBalance = await getCustomerPaymentBalance({
    accountId: account.id,
    remoteJid,
    senderJid,
    showCode: CARRIED_BALANCE_SHOW
  });
  if (carriedBalance > 0) {
    await setCustomerPaymentBalance({
      accountId: account.id,
      remoteJid,
      senderJid,
      showCode: CARRIED_BALANCE_SHOW,
      balance: 0,
      paymentProofId
    });
  }
  const availableAmount = await addCustomerPaymentBalance({
    accountId: account.id,
    remoteJid,
    senderJid,
    showCode: paymentWindow.showCode,
    amount: paymentAmount + carriedBalance,
    paymentProofId
  });
  const availableBookings = await listForwardableBookingsForProof({
    accountId: account.id,
    remoteJid,
    senderJid,
    showCode: paymentWindow.showCode,
    receivedAt
  });
  const bookings = selectCoveredBookings(availableBookings, availableAmount);
  if (bookings.length === 0) {
    const pendingAmount = nextPendingAmount(availableBookings, availableAmount);
    const running = sockets.get(Number(account.id));
    if (running?.socket && pendingAmount > 0) {
      await sendPendingDetails({ account, socket: running.socket, remoteJid, senderJid, pendingAmount });
    }
    await markPaymentProofForwardResult({
      proofId: paymentProofId,
      error: pendingAmount > 0
        ? `Pend : Rs ${replyMoney(pendingAmount)}`
        : "No priced pending booking found for sender/show/amount or forwarding target is not configured"
    });
    await storeListenerEvent({
      account,
      eventType: "booking_forward_skipped",
      detail: pendingAmount > 0
        ? `Pend : Rs ${replyMoney(pendingAmount)}`
        : "No priced pending booking found for sender/show/amount or forwarding target is not configured",
      remoteJid,
      senderJid
    });
    return;
  }

  const running = sockets.get(Number(account.id));
  if (!running?.socket) {
    const error = "WhatsApp socket is not running for this account";
    await markPaymentProofForwardResult({ proofId: paymentProofId, bookingId: bookings[0]?.id || null, error });
    await storeListenerEvent({
      account,
      eventType: "booking_forward_failed",
      detail: error,
      remoteJid,
      senderJid
    });
    return;
  }

  let forwardedTotal = 0;
  let forwardedCount = 0;
  for (const booking of bookings) {
    if (!isShowWindowActive(booking.showCode, new Date())) {
      await setCustomerPaymentBalance({
        accountId: account.id,
        remoteJid,
        senderJid,
        showCode: paymentWindow.showCode,
        balance: 0,
        paymentProofId
      });
      await addCustomerPaymentBalance({
        accountId: account.id,
        remoteJid,
        senderJid,
        showCode: CARRIED_BALANCE_SHOW,
        amount: availableAmount,
        paymentProofId
      });
      await sendTimesUpMessage({ account, socket: running.socket, remoteJid, senderJid, balance: availableAmount });
      await markPaymentProofForwardResult({
        proofId: paymentProofId,
        bookingId: booking.id,
        error: "Times Up - booking window closed before forward"
      });
      await storeListenerEvent({
        account,
        eventType: "booking_forward_skipped",
        detail: "Times Up - booking window closed before forward",
        remoteJid,
        senderJid,
        messageText: booking.messageText
      });
      return;
    }
    const destinationJid = normalizeDestinationJid(booking.destinationJid);
    try {
      await running.socket.sendMessage(destinationJid, { text: booking.messageText });
      await markBookingForwarded({ bookingId: booking.id, paymentProofId, destinationJid });
      await markPaymentProofForwardResult({ proofId: paymentProofId, bookingId: booking.id, forwarded: true });
      await sendForwardAcknowledgement({ account, socket: running.socket, booking });
      forwardedTotal += Number(booking.calculatedPrice || 0);
      forwardedCount += 1;
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

  if (forwardedCount > 0) {
    const balance = await setCustomerPaymentBalance({
      accountId: account.id,
      remoteJid,
      senderJid,
      showCode: paymentWindow.showCode,
      balance: availableAmount - forwardedTotal,
      paymentProofId
    });
    const remainingBookings = availableBookings.filter((booking) => !bookings.some((item) => item.id === booking.id));
    const pendingAmount = nextPendingAmount(remainingBookings, balance);
    if (pendingAmount > 0) {
      await sendPendingDetails({ account, socket: running.socket, remoteJid, senderJid, pendingAmount });
    } else if (balance > 0) {
      await sendBalanceDetails({ account, socket: running.socket, remoteJid, senderJid, balance });
    }
  }
}

function selectCoveredBookings(bookings, amount) {
  let remaining = Number(amount || 0);
  const selected = [];
  for (const booking of bookings || []) {
    const price = Number(booking.calculatedPrice || 0);
    if (price > 0 && price <= remaining) {
      selected.push(booking);
      remaining -= price;
    }
  }
  return selected;
}

function nextPendingAmount(bookings, availableAmount) {
  const next = (bookings || []).find((booking) => Number(booking.calculatedPrice || 0) > Number(availableAmount || 0));
  if (!next) {
    return 0;
  }
  return Number(next.calculatedPrice || 0) - Number(availableAmount || 0);
}

async function sendForwardAcknowledgement({ account, socket, booking }) {
  const customerJid = booking.remoteJid || booking.senderJid || "";
  if (!customerJid) {
    return;
  }

  try {
    const quoted = quotedStoredBookingMessage(booking);
    await socket.sendMessage(customerJid, { text: "Ok 👍" }, quoted ? { quoted } : undefined);
    await storeListenerEvent({
      account,
      eventType: "booking_forward_ack_sent",
      detail: `booking=${booking.id}; quoted=${quoted ? "yes" : "no"}`,
      messageId: booking.messageId || "",
      remoteJid: booking.remoteJid || "",
      senderJid: booking.senderJid || "",
      messageText: "Ok 👍"
    });
  } catch (error) {
    await storeListenerEvent({
      account,
      eventType: "booking_forward_ack_failed",
      detail: error.message || "ack failed",
      messageId: booking.messageId || "",
      remoteJid: booking.remoteJid || "",
      senderJid: booking.senderJid || ""
    });
  }
}

async function sendBalanceDetails({ account, socket, remoteJid, senderJid, balance }) {
  const customerJid = remoteJid || senderJid || "";
  if (!customerJid) {
    return;
  }
  const messageText = `Bal : Rs ${replyMoney(balance)}`;
  try {
    await socket.sendMessage(customerJid, { text: messageText });
    await storeListenerEvent({
      account,
      eventType: "booking_balance_sent",
      detail: messageText,
      remoteJid,
      senderJid,
      messageText
    });
  } catch (error) {
    await storeListenerEvent({
      account,
      eventType: "booking_balance_failed",
      detail: error.message || "balance send failed",
      remoteJid,
      senderJid
    });
  }
}

async function sendPendingDetails({ account, socket, remoteJid, senderJid, pendingAmount }) {
  const customerJid = remoteJid || senderJid || "";
  if (!customerJid) {
    return;
  }
  const messageText = `Pend : Rs ${replyMoney(pendingAmount)}`;
  try {
    await socket.sendMessage(customerJid, { text: messageText });
    await storeListenerEvent({
      account,
      eventType: "booking_pending_sent",
      detail: messageText,
      remoteJid,
      senderJid,
      messageText
    });
  } catch (error) {
    await storeListenerEvent({
      account,
      eventType: "booking_pending_failed",
      detail: error.message || "pending send failed",
      remoteJid,
      senderJid
    });
  }
}

async function sendTimesUpMessage({ account, socket, remoteJid, senderJid, balance = 0 }) {
  const customerJid = remoteJid || senderJid || "";
  if (!customerJid) {
    return;
  }
  const lines = ["Times Up"];
  if (Number(balance || 0) > 0) {
    lines.push(`Bal : Rs ${replyMoney(balance)}`);
  }
  const messageText = lines.join("\n");
  try {
    await socket.sendMessage(customerJid, { text: messageText });
    await storeListenerEvent({
      account,
      eventType: "booking_times_up_sent",
      detail: messageText,
      remoteJid,
      senderJid,
      messageText
    });
  } catch (error) {
    await storeListenerEvent({
      account,
      eventType: "booking_times_up_failed",
      detail: error.message || "times up send failed",
      remoteJid,
      senderJid
    });
  }
}

function quotedStoredBookingMessage(booking) {
  const stored = booking.messageJson || {};
  if (stored?.key && stored?.message) {
    return {
      key: stored.key,
      message: stored.message,
      pushName: stored.pushName || booking.pushName || ""
    };
  }
  if (!booking.messageId || !booking.remoteJid) {
    return null;
  }
  return {
    key: {
      id: booking.messageId,
      remoteJid: booking.remoteJid,
      participant: booking.senderJid || undefined,
      fromMe: false
    },
    message: {
      conversation: booking.messageText || ""
    },
    pushName: booking.pushName || ""
  };
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

function mediaMessageLabel(message = {}) {
  if (message.imageMessage) return "[image]";
  if (message.videoMessage) return "[video]";
  if (message.documentMessage) return `[document] ${message.documentMessage.fileName || ""}`.trim();
  if (message.audioMessage) return "[audio]";
  if (message.stickerMessage) return "[sticker]";
  return "";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
