const state = {
  accounts: [],
  bookings: [],
  stats: [],
  events: [],
  proofs: [],
  support: { kpis: {}, balances: [], support: [], agents: [] },
  forwardTargets: [],
  forwardChats: [],
  credits: [],
  session: null
};
let refreshTimer = null;
const ADMIN_API_BASE = (window.WA_ADMIN_API_BASE || "/admin/api").replace(/\/$/, "");

const pageMeta = {
  overview: ["Overview", "Production control for WhatsApp booking capture."],
  accounts: ["WhatsApp Accounts", "Connect, start, stop, and inspect linked accounts."],
  bookings: ["Bookings", "Captured customer messages by account and show."],
  events: ["Listener Events", "Live diagnostics for received, skipped, and captured messages."],
  proofs: ["Payment Proofs", "OCR metadata from WhatsApp payment screenshots matched against credits."],
  support: ["Support", "Customer balances, payment gaps, manual work, and agent booking health."],
  forwarding: ["Forwarding", "Configure where paid prediction messages are forwarded for each show."],
  credits: ["Credits", "Recent bank credit history received by the system."]
};

document.getElementById("loginForm").onsubmit = login;
document.getElementById("logout").onclick = logout;
document.getElementById("refreshAll").onclick = refreshAll;
document.getElementById("addAccount").onclick = addAccount;
document.getElementById("loadBookings").onclick = loadBookings;
document.getElementById("loadEvents").onclick = loadEvents;
document.getElementById("loadProofs").onclick = loadProofs;
document.getElementById("loadSupport").onclick = loadSupport;
document.getElementById("loadCredits").onclick = loadCredits;
document.getElementById("loadForwardChats").onclick = loadForwardChats;
document.getElementById("forwardChatSearch").oninput = renderForwardRows;

for (const button of document.querySelectorAll(".tab")) {
  button.onclick = () => showTab(button.dataset.tab);
}

init();

async function init() {
  const session = await api("/session", { allowUnauthorized: true });
  state.session = session;
  document.getElementById("totpLabel").classList.toggle("hidden", !session.totpEnabled);
  if (!session.configured) {
    showLoginError("Admin login is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD, and ADMIN_SESSION_SECRET.");
    return;
  }
  if (session.authenticated) {
    showApp();
    startAutoRefresh();
    refreshAll();
  }
}

async function login(event) {
  event.preventDefault();
  clearLoginError();
  try {
    await api("/login", {
      method: "POST",
      allowUnauthorized: true,
      body: {
        username: document.getElementById("username").value,
        password: document.getElementById("password").value,
        totp: document.getElementById("totp").value
      }
    });
    showApp();
    startAutoRefresh();
    refreshAll();
  } catch (error) {
    showLoginError(error.message);
  }
}

async function logout() {
  await api("/logout", { method: "POST", allowUnauthorized: true });
  showLogin();
}

function showApp() {
  document.getElementById("loginView").classList.add("hidden");
  document.getElementById("appView").classList.remove("hidden");
}

async function api(path, options = {}) {
  const response = await fetch(`${ADMIN_API_BASE}${path}`, {
    method: options.method || "GET",
    credentials: "include",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const json = await response.json();
  if ((!response.ok || !json.ok) && !options.allowUnauthorized) {
    if (response.status === 401) {
      showLogin();
    }
    throw new Error(json.error || JSON.stringify(json));
  }
  if (!response.ok || !json.ok) {
    throw new Error(json.error || JSON.stringify(json));
  }
  return json;
}

function showLogin() {
  stopAutoRefresh();
  document.getElementById("appView").classList.add("hidden");
  document.getElementById("loginView").classList.remove("hidden");
}

function showTab(tab) {
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item.dataset.tab === tab));
  document.querySelectorAll(".panel").forEach((item) => item.classList.toggle("active", item.id === tab));
  document.getElementById("pageTitle").textContent = pageMeta[tab][0];
  document.getElementById("pageSub").textContent = pageMeta[tab][1];
  if (tab === "bookings") loadBookings();
  if (tab === "events") loadEvents();
  if (tab === "proofs") loadProofs();
  if (tab === "support") loadSupport();
  if (tab === "forwarding") loadForwardTargets();
  if (tab === "credits") loadCredits();
}

async function refreshAll() {
  await Promise.all([refreshAccounts(), loadBookings(), loadBookingStats(), loadEvents(), loadProofs(), loadSupport(), loadForwardTargets(), loadCredits()]);
  renderOverview();
  markUpdated();
}

async function refreshAccounts() {
  const json = await api("/accounts");
  state.accounts = json.accounts || [];
  renderAccounts();
  renderAccountFilter();
  renderEventAccountFilter();
  renderProofAccountFilter();
  renderSupportAccountFilter();
  renderForwardAccountFilter();
}

async function addAccount() {
  await api("/accounts", {
    method: "POST",
    body: {
      accountKey: document.getElementById("accountKey").value,
      displayName: document.getElementById("displayName").value,
      phoneNumber: document.getElementById("phoneNumber").value
    }
  });
  document.getElementById("accountKey").value = "";
  document.getElementById("displayName").value = "";
  document.getElementById("phoneNumber").value = "";
  refreshAccounts();
}

function renderAccounts() {
  const root = document.getElementById("accountList");
  if (!state.accounts.length) {
    root.innerHTML = `<div class="surface">No WhatsApp accounts added.</div>`;
    return;
  }
  root.innerHTML = state.accounts.map((account) => `
    <div class="account-card" id="account-${account.id}">
      <div class="card-head">
        <h3>${escapeHtml(account.displayName || account.accountKey)}</h3>
        ${listeningBadge(account)}
      </div>
      <div class="meta">
        Key: ${escapeHtml(account.accountKey)}<br>
        Phone: ${escapeHtml(account.phoneNumber || "-")}<br>
        Status: <span class="status">${escapeHtml(account.lastStatus || "-")}</span><br>
        Test capture: ${account.testCaptureEnabled ? "on" : "off"}<br>
        JID: ${escapeHtml(account.connectedJid || "-")}<br>
        Error: ${escapeHtml(account.lastError || "-")}
      </div>
      <div class="actions">
        <button class="icon-btn" onclick="startAccount(${account.id})" title="Start listener">▶</button>
        <button class="icon-btn secondary" onclick="stopAccount(${account.id})" title="Stop listener">■</button>
        ${account.lastStatus === "connected" ? "" : `<button class="icon-btn secondary" onclick="showQr(${account.id})" title="Show QR">▦</button>`}
        <button class="icon-btn secondary" onclick="toggleTestCapture(${account.id}, ${account.testCaptureEnabled ? "false" : "true"})" title="${account.testCaptureEnabled ? "Stop test capture" : "Start test capture"}">
          ●
        </button>
      </div>
      <div class="qr-slot"></div>
    </div>
  `).join("");
}

function listeningBadge(account) {
  const status = account.lastStatus || "";
  if (status === "connected" && account.testCaptureEnabled) {
    return `<span class="listen-badge test"><span></span>TEST LISTENING</span>`;
  }
  if (status === "connected") {
    return `<span class="listen-badge"><span></span>WINDOW READY</span>`;
  }
  if (["starting", "qr_ready", "disconnected_retrying"].includes(status)) {
    const label = {
      starting: "STARTING",
      qr_ready: "QR READY",
      disconnected_retrying: "RETRYING"
    }[status];
    return `<span class="listen-badge pending"><span></span>${label}</span>`;
  }
  return `<span class="listen-badge off">OFF</span>`;
}

async function startAccount(id) {
  await api(`/accounts/${id}/start`, { method: "POST" });
  await refreshAll();
  setTimeout(refreshAll, 1500);
}

async function stopAccount(id) {
  await api(`/accounts/${id}/stop`, { method: "POST" });
  refreshAll();
}

async function showQr(id) {
  const slot = document.querySelector(`#account-${id} .qr-slot`);
  slot.innerHTML = "Starting listener...";
  try {
    await api(`/accounts/${id}/start`, { method: "POST" });
    await wait(1800);
    const json = await api(`/accounts/${id}/qr`);
    slot.innerHTML = `<img class="qr" src="${json.dataUrl}" alt="WhatsApp QR">`;
    refreshAll();
  } catch (error) {
    slot.innerHTML = `<div class="meta">${escapeHtml(error.message)}</div>`;
  }
}

async function toggleTestCapture(id, enabled) {
  const card = document.getElementById(`account-${id}`);
  if (card) {
    card.classList.add("busy");
  }
  await api(`/accounts/${id}/test-capture`, {
    method: "POST",
    body: { enabled }
  });
  await refreshAccounts();
  await loadBookings();
  await loadEvents();
  await loadProofs();
  renderOverview();
  markUpdated();
}

function renderAccountFilter() {
  const select = document.getElementById("bookingAccount");
  select.innerHTML = `<option value="0">All accounts</option>` + state.accounts.map((account) =>
    `<option value="${account.id}">${escapeHtml(account.displayName || account.accountKey)}</option>`
  ).join("");
}

function renderEventAccountFilter() {
  const select = document.getElementById("eventAccount");
  select.innerHTML = `<option value="0">All accounts</option>` + state.accounts.map((account) =>
    `<option value="${account.id}">${escapeHtml(account.displayName || account.accountKey)}</option>`
  ).join("");
}

function renderProofAccountFilter() {
  const select = document.getElementById("proofAccount");
  select.innerHTML = `<option value="0">All accounts</option>` + state.accounts.map((account) =>
    `<option value="${account.id}">${escapeHtml(account.displayName || account.accountKey)}</option>`
  ).join("");
}

function renderSupportAccountFilter() {
  const select = document.getElementById("supportAccount");
  if (!select) return;
  const selected = select.value || "0";
  select.innerHTML = `<option value="0">All accounts</option>` + state.accounts.map((account) =>
    `<option value="${account.id}">${escapeHtml(account.displayName || account.accountKey)}</option>`
  ).join("");
  select.value = [...select.options].some((option) => option.value === selected) ? selected : "0";
}

function renderForwardAccountFilter() {
  const select = document.getElementById("forwardAccount");
  const selected = select.value;
  select.innerHTML = state.accounts.map((account) =>
    `<option value="${account.id}">${escapeHtml(account.displayName || account.accountKey)} - ${escapeHtml(account.lastStatus || "-")}</option>`
  ).join("");
  if (selected && [...select.options].some((option) => option.value === selected)) {
    select.value = selected;
  } else {
    const connected = state.accounts.find((account) => account.lastStatus === "connected");
    if (connected) select.value = String(connected.id);
  }
}

async function loadBookings() {
  const accountId = document.getElementById("bookingAccount").value || "0";
  const showCode = document.getElementById("showCode").value || "";
  const json = await api(`/bookings?accountId=${encodeURIComponent(accountId)}&showCode=${encodeURIComponent(showCode)}&limit=200`);
  state.bookings = json.bookings || [];
  renderBookingRows();
  markUpdated();
}

function renderBookingRows() {
  const rows = document.getElementById("bookingRows");
  rows.innerHTML = state.bookings.map((item) => `
    <tr>
      <td>${formatDate(item.receivedAt)}</td>
      <td>${escapeHtml(item.accountKey)}</td>
      <td>${showBadge(item.showCode)}</td>
      <td>${contactLabel(item)}</td>
      <td>${bookingPrice(item)}</td>
      <td>${bookingForwardStatus(item)}</td>
      <td class="message">${escapeHtml(item.messageText)}</td>
      <td><button class="icon-btn danger" onclick="deleteBooking(${item.id})" title="Delete booking">×</button></td>
    </tr>
  `).join("") || `<tr><td colspan="8">No bookings captured.</td></tr>`;
}

async function loadBookingStats() {
  const json = await api("/booking-stats?days=30");
  state.stats = json.stats || [];
  renderDashboardCharts();
  renderStatsRows();
}

function renderDashboardCharts() {
  renderShowChart();
  renderNetChart();
  renderProofChart();
}

function renderShowChart() {
  const root = document.getElementById("showChart");
  if (!root) return;
  const totals = new Map();
  for (const item of state.stats) {
    const key = item.showCode || "-";
    totals.set(key, (totals.get(key) || 0) + Number(item.bookingAmount || 0));
  }
  const entries = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = Math.max(...entries.map(([, value]) => value), 1);
  root.innerHTML = entries.map(([show, value], index) => `
    <div class="bar-row">
      <span>${showBadge(show)}</span>
      <div class="bar-track"><div class="bar-fill color-${index % 5}" style="width:${Math.max((value / max) * 100, 5)}%"></div></div>
      <strong>Rs ${money(value)}</strong>
    </div>
  `).join("") || `<div class="empty-note">No booking amount yet.</div>`;
}

function renderNetChart() {
  const root = document.getElementById("netChart");
  if (!root) return;
  const byDate = new Map();
  for (const item of state.stats) {
    const date = formatDateOnly(item.date);
    const current = byDate.get(date) || 0;
    byDate.set(date, current + Number(item.bookingAmount || 0) - Number(item.payoutAmount || 0));
  }
  const entries = [...byDate.entries()].slice(0, 7).reverse();
  const max = Math.max(...entries.map(([, value]) => Math.abs(value)), 1);
  root.innerHTML = entries.map(([date, value]) => `
    <div class="net-col">
      <div class="net-stick ${value < 0 ? "negative" : "positive"}" style="height:${Math.max((Math.abs(value) / max) * 96, 8)}px"></div>
      <strong>Rs ${money(value)}</strong>
      <span>${escapeHtml(date)}</span>
    </div>
  `).join("") || `<div class="empty-note">No net stats yet.</div>`;
}

function renderProofChart() {
  const root = document.getElementById("proofChart");
  if (!root) return;
  const statuses = ["matched", "not_found", "amount_mismatch", "ocr_failed"];
  const labels = {
    matched: "Matched",
    not_found: "Not found",
    amount_mismatch: "Mismatch",
    ocr_failed: "OCR failed"
  };
  root.innerHTML = statuses.map((status, index) => {
    const count = state.proofs.filter((item) => item.status === status).length;
    return `<div class="proof-chip color-${index}"><strong>${count}</strong><span>${labels[status]}</span></div>`;
  }).join("");
}

function renderStatsRows() {
  const rows = document.getElementById("statsRows");
  rows.innerHTML = state.stats.map((item) => {
    const booking = Number(item.bookingAmount || 0);
    const payout = Number(item.payoutAmount || 0);
    return `
      <tr>
        <td>${formatDateOnly(item.date)}</td>
        <td>${showBadge(item.showCode || "-")}</td>
        <td>${escapeHtml(item.bookingCount)}</td>
        <td>₹${money(booking)}</td>
        <td>${escapeHtml(item.manualCount)}</td>
        <td>${escapeHtml(item.winnerCount)}</td>
        <td>₹${money(payout)}</td>
        <td>₹${money(booking - payout)}</td>
      </tr>
    `;
  }).join("") || `<tr><td colspan="8">No stats yet.</td></tr>`;
}

async function deleteBooking(id) {
  if (!confirm("Delete this booking message?")) return;
  await api(`/bookings/${id}`, { method: "DELETE" });
  await loadBookings();
  renderOverview();
  markUpdated();
}

async function loadEvents() {
  const accountId = document.getElementById("eventAccount").value || "0";
  const json = await api(`/listener-events?accountId=${encodeURIComponent(accountId)}&limit=200`);
  state.events = json.events || [];
  renderEventRows();
  markUpdated();
}

function renderEventRows() {
  const rows = document.getElementById("eventRows");
  rows.innerHTML = state.events.map((item) => `
    <tr>
      <td>${formatDate(item.createdAt)}</td>
      <td>${escapeHtml(item.accountKey)}</td>
      <td>${eventBadge(item.eventType)}</td>
      <td>${escapeHtml(item.detail)}</td>
      <td class="message">${escapeHtml(item.messageText || item.messageId || "")}</td>
    </tr>
  `).join("") || `<tr><td colspan="5">No listener events yet.</td></tr>`;
}

async function loadProofs() {
  const accountId = document.getElementById("proofAccount").value || "0";
  const json = await api(`/payment-proofs?accountId=${encodeURIComponent(accountId)}&limit=200`);
  state.proofs = json.proofs || [];
  renderProofRows();
  markUpdated();
}

async function loadSupport() {
  const accountId = document.getElementById("supportAccount")?.value || "0";
  const json = await api(`/support-summary?accountId=${encodeURIComponent(accountId)}&limit=200`);
  state.support = {
    kpis: json.kpis || {},
    balances: json.balances || [],
    support: json.support || [],
    agents: json.agents || []
  };
  renderSupport();
  markUpdated();
}

function renderSupport() {
  const kpis = state.support.kpis || {};
  document.getElementById("supportSuccess").textContent = kpis.successfulBookings || 0;
  document.getElementById("supportMissing").textContent = kpis.paymentMissingBookings || 0;
  document.getElementById("supportBalance").textContent = kpis.customersWithBalance || 0;
  document.getElementById("supportManual").textContent = kpis.manualSupportBookings || 0;

  document.getElementById("supportQueue").innerHTML = (state.support.support || []).slice(0, 80).map((item) => {
    const type = item.manualWork ? "Manual" : Number(item.pendingAmount || 0) > 0 ? `Pend Rs ${money(item.pendingAmount)}` : "Paid wait";
    return `
      <div class="support-item ${item.manualWork ? "manual" : ""}">
        <div><strong>${contactLabel(item)}</strong><span>${formatDate(item.receivedAt)} | ${escapeHtml(item.accountName || item.accountKey)} | ${showBadge(item.showCode)}</span></div>
        <b>${escapeHtml(type)}</b>
        <p>${escapeHtml(item.messageText || "").slice(0, 220)}</p>
      </div>
    `;
  }).join("") || `<div class="empty-note">No support queue.</div>`;

  document.getElementById("supportBalances").innerHTML = (state.support.balances || []).slice(0, 80).map((item) => `
    <div class="support-item balance">
      <div><strong>${contactLabel(item)}</strong><span>${escapeHtml(item.accountName || item.accountKey)} | ${showBadge(item.showCode)}</span></div>
      <b>Rs ${money(item.balanceAmount)}</b>
    </div>
  `).join("") || `<div class="empty-note">No customer balances.</div>`;

  document.getElementById("supportAgentRows").innerHTML = (state.support.agents || []).map((item) => `
    <tr>
      <td>${escapeHtml(item.accountName || item.accountKey)}</td>
      <td>${escapeHtml(item.customerCount)}</td>
      <td>${escapeHtml(item.bookingCount)}</td>
      <td>Rs ${money(item.bookingAmount)}</td>
      <td>${escapeHtml(item.successCount)}</td>
      <td>${escapeHtml(item.paymentMissingCount)}</td>
      <td>${escapeHtml(item.manualCount)}</td>
    </tr>
  `).join("") || `<tr><td colspan="7">No agent booking data.</td></tr>`;
}

function renderProofRows() {
  const rows = document.getElementById("proofRows");
  rows.innerHTML = state.proofs.map((item) => {
    const reference = item.transactionId || item.utr || item.proof?.uniqueReference || "-";
    const preview = item.ocrText || item.proof?.rawText || "";
    return `
      <tr>
        <td>${formatDate(item.receivedAt)}</td>
        <td>${escapeHtml(item.accountKey)}</td>
        <td>${contactLabel(item)}</td>
        <td>${item.amount ? `Rs ${money(item.amount)}` : "-"}</td>
        <td>${escapeHtml(reference)}</td>
        <td>${proofStatus(item)}</td>
        <td>${proofForwardStatus(item)}</td>
        <td class="message">${escapeHtml(preview).slice(0, 500)}</td>
      </tr>
    `;
  }).join("") || `<tr><td colspan="8">No payment screenshots captured.</td></tr>`;
}

async function loadForwardTargets() {
  if (isEditingForwarding()) {
    markUpdated();
    return;
  }
  const json = await api("/forward-targets");
  state.forwardTargets = normalizeForwardTargets(json.targets || []);
  renderForwardRows();
  markUpdated();
}

async function loadForwardChats() {
  const accountId = document.getElementById("forwardAccount").value;
  const search = document.getElementById("forwardChatSearch").value || "";
  const status = document.getElementById("forwardChatStatus");
  const drafts = captureForwardDrafts();
  if (!accountId) {
    status.textContent = "No WhatsApp account selected.";
    return;
  }
  status.textContent = "Loading chats...";
  try {
    const json = await api(`/accounts/${encodeURIComponent(accountId)}/chats?refresh=1&q=${encodeURIComponent(search)}`);
    state.forwardChats = json.chats || [];
    restoreForwardDrafts(drafts);
    status.textContent = `${state.forwardChats.length} chats loaded`;
    forceRenderForwardRows();
  } catch (error) {
    state.forwardChats = [];
    restoreForwardDrafts(drafts);
    status.textContent = error.message;
    forceRenderForwardRows();
  }
}

function normalizeForwardTargets(targets) {
  const byShow = new Map(targets.map((target) => [target.showCode, target]));
  return showOptions().map((show) => ({
    showCode: show.code,
    label: byShow.get(show.code)?.label || show.label,
    destinationJid: byShow.get(show.code)?.destinationJid || "",
    isEnabled: Boolean(byShow.get(show.code)?.isEnabled)
  }));
}

function renderForwardRows() {
  if (isEditingForwarding()) {
    return;
  }
  forceRenderForwardRows();
}

function forceRenderForwardRows() {
  const rows = document.getElementById("forwardRows");
  const chats = filteredForwardChats();
  rows.innerHTML = state.forwardTargets.map((item) => `
    <tr>
      <td>${showBadge(item.showCode)}</td>
      <td><input id="forward-label-${item.showCode}" value="${escapeHtml(item.label)}" placeholder="Name"></td>
      <td>
        <div class="chat-picker">
          <span id="forward-icon-${item.showCode}" class="chat-type ${selectedChatType(item.destinationJid)}">${selectedChatType(item.destinationJid) === "group" ? "G" : "C"}</span>
          <select id="forward-chat-${item.showCode}" onchange="selectForwardChat('${item.showCode}')">
            <option value="">Select loaded chat/group</option>
            ${currentChatOption(item, chats)}
            ${chats.map((chat) => `<option value="${escapeHtml(chat.jid)}" ${chat.jid === item.destinationJid ? "selected" : ""}>${chat.type === "group" ? "Group" : "Chat"} | ${escapeHtml(chat.name)} | ${escapeHtml(chat.jid)}</option>`).join("")}
          </select>
        </div>
      </td>
      <td><input id="forward-enabled-${item.showCode}" type="checkbox" ${item.isEnabled ? "checked" : ""}></td>
      <td><button class="icon-btn" onclick="saveForwardTarget('${item.showCode}')" title="Save target">✓</button></td>
    </tr>
  `).join("");
}

function captureForwardDrafts() {
  const rows = document.getElementById("forwardRows");
  if (!rows) return new Map();
  return new Map(state.forwardTargets.map((item) => {
    const label = document.getElementById(`forward-label-${item.showCode}`)?.value;
    const chat = document.getElementById(`forward-chat-${item.showCode}`)?.value;
    const enabled = document.getElementById(`forward-enabled-${item.showCode}`)?.checked;
    return [item.showCode, {
      label: label ?? item.label,
      destinationJid: chat ?? item.destinationJid,
      isEnabled: enabled ?? item.isEnabled
    }];
  }));
}

function restoreForwardDrafts(drafts) {
  state.forwardTargets = state.forwardTargets.map((item) => ({
    ...item,
    ...(drafts.get(item.showCode) || {})
  }));
}

function filteredForwardChats() {
  const search = (document.getElementById("forwardChatSearch").value || "").trim().toLowerCase();
  return state.forwardChats.filter((chat) => !search
    || chat.name.toLowerCase().includes(search)
    || chat.jid.toLowerCase().includes(search)
    || chat.type.toLowerCase().includes(search));
}

function currentChatOption(item, chats) {
  if (!item.destinationJid || chats.some((chat) => chat.jid === item.destinationJid)) {
    return "";
  }
  return `<option value="${escapeHtml(item.destinationJid)}" selected>Current | ${escapeHtml(item.destinationJid)}</option>`;
}

function selectForwardChat(showCode) {
  const select = document.getElementById(`forward-chat-${showCode}`);
  const icon = document.getElementById(`forward-icon-${showCode}`);
  const type = selectedChatType(select.value);
  icon.textContent = type === "group" ? "G" : "C";
  icon.className = `chat-type ${type}`;
}

async function saveForwardTarget(showCode) {
  await api(`/forward-targets/${encodeURIComponent(showCode)}`, {
    method: "PUT",
    body: {
      label: document.getElementById(`forward-label-${showCode}`).value,
      destinationJid: document.getElementById(`forward-chat-${showCode}`).value,
      isEnabled: document.getElementById(`forward-enabled-${showCode}`).checked
    }
  });
  await loadForwardTargets();
  await loadEvents();
  markUpdated();
}

function isEditingForwarding() {
  const active = document.activeElement;
  return Boolean(active?.closest?.("#forwarding"));
}

async function loadCredits() {
  const json = await api("/credits?limit=150");
  state.credits = json.credits || [];
  renderCreditRows();
  markUpdated();
}

function renderCreditRows() {
  const rows = document.getElementById("creditRows");
  rows.innerHTML = state.credits.map((item) => `
    <tr>
      <td>${formatDate(item.receivedAt)}</td>
      <td>₹${escapeHtml(item.amount || "-")}</td>
      <td>${escapeHtml(item.bankName || item.sender || "-")}</td>
      <td>${escapeHtml(creditDeviceLabel(item))}</td>
      <td class="message">${escapeHtml(item.rawText || item.messageText || "")}</td>
      <td><button class="icon-btn danger" onclick="deleteCredit(${item.id})" title="Delete credit">×</button></td>
    </tr>
  `).join("") || `<tr><td colspan="6">No credits found.</td></tr>`;
}

async function deleteCredit(id) {
  if (!confirm("Delete this credit record?")) return;
  await api(`/credits/${id}`, { method: "DELETE" });
  await loadCredits();
  renderOverview();
  markUpdated();
}

function renderOverview() {
  document.getElementById("statAccounts").textContent = state.accounts.length;
  document.getElementById("statRunning").textContent = state.accounts.filter((item) => item.lastStatus === "connected").length;
  document.getElementById("statBookings").textContent = state.bookings.length;
  document.getElementById("statCredits").textContent = state.credits.length;
  renderDashboardCharts();
  document.getElementById("recentBookings").innerHTML = state.bookings.slice(0, 6).map((item) =>
    `<div class="list-item"><strong>${escapeHtml(item.accountKey)}</strong> ${escapeHtml(item.showCode)} <span class="item-time">${formatDate(item.receivedAt)}</span><br>${escapeHtml(item.messageText).slice(0, 180)}</div>`
  ).join("") || `<div class="list-item">No bookings yet.</div>`;
  document.getElementById("recentCredits").innerHTML = state.credits.slice(0, 6).map((item) =>
    `<div class="list-item"><strong>₹${escapeHtml(item.amount || "-")}</strong> ${formatDate(item.receivedAt)}<br>${escapeHtml(item.rawText || "").slice(0, 180)}</div>`
  ).join("") || `<div class="list-item">No credits yet.</div>`;
  renderStatsRows();
}

function showLoginError(message) {
  document.getElementById("loginError").textContent = message;
}

function clearLoginError() {
  document.getElementById("loginError").textContent = "";
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

function formatDateOnly(value) {
  return value ? new Date(value).toLocaleDateString() : "-";
}

function money(value) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function bookingPrice(item) {
  if (item.manualWork) return `<span class="status">Manual</span>`;
  if (item.calculatedPrice === null || item.calculatedPrice === undefined || item.calculatedPrice === "") return "-";
  return `₹${money(item.calculatedPrice)}`;
}

function showBadge(showCode) {
  const text = String(showCode || "-");
  const key = text.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `<span class="chip show-${escapeHtml(key)}">${escapeHtml(text)}</span>`;
}

function eventBadge(eventType) {
  const type = String(eventType || "-");
  const tone = type.includes("failed") ? "bad" : type.includes("captured") || type.includes("forwarded") ? "good" : "neutral";
  return `<span class="chip ${tone}">${escapeHtml(type)}</span>`;
}

function bookingForwardStatus(item) {
  if (item.forwardedAt) {
    return `<span class="status">Sent</span><br><span class="meta">${escapeHtml(item.forwardedToJid || "")}</span>`;
  }
  if (item.forwardError) {
    return `<span class="status">Failed</span><br><span class="meta">${escapeHtml(item.forwardError)}</span>`;
  }
  return "-";
}

function proofStatus(item) {
  const labels = {
    matched: "Matched",
    amount_mismatch: "Amount mismatch",
    not_found: "Not found",
    ocr_failed: "OCR failed",
    parsed: "Parsed"
  };
  const status = item.status || "parsed";
  const matched = item.matchedCreditId ? ` #${escapeHtml(item.matchedCreditId)}` : "";
  return `<span class="status">${escapeHtml(labels[status] || status)}${matched}</span>`;
}

function proofForwardStatus(item) {
  if (item.forwardedAt) {
    return `<span class="status">Sent</span>`;
  }
  if (item.forwardError) {
    return `<span class="status">Pending</span><br><span class="meta">${escapeHtml(item.forwardError)}</span>`;
  }
  if (item.matchedBookingId) {
    return `<span class="status">Booking #${escapeHtml(item.matchedBookingId)}</span>`;
  }
  return "-";
}

function showOptions() {
  return [
    { code: "1PM_DEAR", label: "1PM Dear" },
    { code: "3PM_KL", label: "3PM Kerala" },
    { code: "6PM_DEAR", label: "6PM Dear" },
    { code: "8PM_DEAR", label: "8PM Dear" },
    { code: "TEST_CAPTURE", label: "Test capture" }
  ];
}

function selectedChatType(jid) {
  return /@g\.us$/i.test(String(jid || "")) ? "group" : "chat";
}

function contactLabel(item) {
  const remote = jidToNumber(item.remoteJid);
  const sender = jidToNumber(item.senderJid);
  const number = remote || sender;
  const name = item.pushName ? ` (${escapeHtml(item.pushName)})` : "";
  const chat = whatsappChatLink(item);
  const chatLink = chat ? `<br><a class="chat-link" href="${chat}" target="_blank" rel="noopener">Open chat</a>` : "";
  if (remote && sender && remote !== sender) {
    return `${escapeHtml(remote)} / ${escapeHtml(sender)}${name}${chatLink}`;
  }
  return `${escapeHtml(number || item.senderJid || item.remoteJid || "-")}${name}${chatLink}`;
}

function creditDeviceLabel(item) {
  const phones = Array.isArray(item.phoneNumbers) ? item.phoneNumbers.filter(Boolean).join(", ") : "";
  return phones || item.receivedPhoneNumber || item.deviceName || item.deviceId || "-";
}

function jidToNumber(value) {
  const text = String(value || "");
  const user = text.split("@")[0].split(":")[0];
  const match = user.match(/\d{8,}/);
  if (!match) return "";
  return match[0].startsWith("91") && match[0].length > 10 ? match[0].slice(-10) : match[0];
}

function whatsappChatLink(item) {
  const phone = jidToWhatsappPhone(item.senderJid) || jidToWhatsappPhone(item.remoteJid);
  return phone ? `https://wa.me/${phone}` : "";
}

function jidToWhatsappPhone(value) {
  const text = String(value || "");
  if (/@g\.us$/i.test(text)) {
    return "";
  }
  const user = text.split("@")[0].split(":")[0];
  const match = user.match(/\d{8,}/);
  if (!match) return "";
  const digits = match[0];
  return digits.length === 10 ? `91${digits}` : digits;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (!document.hidden && isAppVisible()) {
      refreshVisible().catch((error) => console.warn(error));
    }
  }, 5000);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

async function refreshVisible() {
  if (!isAppVisible()) {
    return;
  }
  const active = document.querySelector(".panel.active")?.id || "overview";
  if (active === "accounts") {
    await refreshAccounts();
  } else if (active === "bookings") {
    await Promise.all([refreshAccounts(), loadBookings()]);
  } else if (active === "events") {
    await Promise.all([refreshAccounts(), loadEvents()]);
  } else if (active === "proofs") {
    await Promise.all([refreshAccounts(), loadProofs()]);
  } else if (active === "forwarding") {
    await loadForwardTargets();
  } else if (active === "credits") {
    await loadCredits();
  } else {
    await refreshAll();
  }
  renderOverview();
  markUpdated();
}

function isAppVisible() {
  return !document.getElementById("appView").classList.contains("hidden");
}

function markUpdated() {
  const label = document.getElementById("lastUpdated");
  if (label) {
    label.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }
}

window.startAccount = startAccount;
window.stopAccount = stopAccount;
window.showQr = showQr;
window.toggleTestCapture = toggleTestCapture;
window.deleteBooking = deleteBooking;
window.deleteCredit = deleteCredit;
window.saveForwardTarget = saveForwardTarget;
window.selectForwardChat = selectForwardChat;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
