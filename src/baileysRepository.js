import { query } from "./db.js";

export async function listListenerAccounts({ activeOnly = false } = {}) {
  const result = await query(
    `
      SELECT
        id,
        account_key AS "accountKey",
        display_name AS "displayName",
        phone_number AS "phoneNumber",
        is_active AS "isActive",
        listen_enabled AS "listenEnabled",
        test_capture_enabled AS "testCaptureEnabled",
        connected_jid AS "connectedJid",
        last_status AS "lastStatus",
        last_error AS "lastError",
        latest_qr AS "latestQr",
        last_seen_at AS "lastSeenAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM whatsapp_listener_accounts
      WHERE ($1::BOOLEAN = FALSE OR (is_active = TRUE AND listen_enabled = TRUE))
      ORDER BY id ASC
    `,
    [activeOnly]
  );
  return result.rows;
}

export async function upsertListenerAccount({ accountKey, displayName = "", phoneNumber = "" }) {
  const safeKey = normalizeAccountKey(accountKey);
  if (!safeKey) {
    throw new Error("accountKey is required");
  }
  const result = await query(
    `
      INSERT INTO whatsapp_listener_accounts (account_key, display_name, phone_number)
      VALUES ($1, $2, $3)
      ON CONFLICT (account_key) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        phone_number = EXCLUDED.phone_number,
        is_active = TRUE,
        listen_enabled = TRUE,
        updated_at = NOW()
      RETURNING
        id,
        account_key AS "accountKey",
        display_name AS "displayName",
        phone_number AS "phoneNumber",
        is_active AS "isActive",
        listen_enabled AS "listenEnabled",
        test_capture_enabled AS "testCaptureEnabled",
        last_status AS "lastStatus",
        latest_qr AS "latestQr"
    `,
    [safeKey, displayName, phoneNumber]
  );
  return result.rows[0];
}

export async function getListenerAccountById(accountId) {
  const result = await query(
    `
      SELECT
        id,
        account_key AS "accountKey",
        display_name AS "displayName",
        phone_number AS "phoneNumber",
        is_active AS "isActive",
        listen_enabled AS "listenEnabled",
        test_capture_enabled AS "testCaptureEnabled",
        connected_jid AS "connectedJid",
        last_status AS "lastStatus",
        last_error AS "lastError",
        latest_qr AS "latestQr",
        last_seen_at AS "lastSeenAt"
      FROM whatsapp_listener_accounts
      WHERE id = $1
    `,
    [accountId]
  );
  return result.rows[0] || null;
}

export async function setListenerEnabled(accountId, enabled) {
  const result = await query(
    `
      UPDATE whatsapp_listener_accounts
      SET listen_enabled = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        account_key AS "accountKey",
        display_name AS "displayName",
        phone_number AS "phoneNumber",
        is_active AS "isActive",
        listen_enabled AS "listenEnabled",
        test_capture_enabled AS "testCaptureEnabled",
        last_status AS "lastStatus"
    `,
    [accountId, enabled]
  );
  return result.rows[0] || null;
}

export async function setTestCaptureEnabled(accountId, enabled) {
  const result = await query(
    `
      UPDATE whatsapp_listener_accounts
      SET test_capture_enabled = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        account_key AS "accountKey",
        test_capture_enabled AS "testCaptureEnabled"
    `,
    [accountId, enabled]
  );
  return result.rows[0] || null;
}

export async function updateListenerAccountStatus(accountId, { status, error = "", qr = "", connectedJid = "" }) {
  await query(
    `
      UPDATE whatsapp_listener_accounts
      SET
        last_status = COALESCE(NULLIF($2, ''), last_status),
        last_error = $3,
        latest_qr = $4,
        connected_jid = COALESCE(NULLIF($5, ''), connected_jid),
        last_seen_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `,
    [accountId, status || "", error || "", qr || "", connectedJid || ""]
  );
}

export async function storeInboundWhatsappMessage({
  account,
  messageId,
  remoteJid,
  senderJid,
  pushName,
  messageText,
  messageJson,
  showCode,
  listenerWindow,
  pricing,
  receivedAt
}) {
  const result = await query(
    `
      INSERT INTO whatsapp_inbound_messages (
        account_id,
        account_key,
        message_id,
        remote_jid,
        sender_jid,
        push_name,
        message_text,
        message_json,
        show_code,
        listener_window,
        calculated_price,
        pricing_breakdown,
        manual_work,
        received_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9, $10::JSONB, $11, $12::JSONB, $13, $14)
      ON CONFLICT (account_id, message_id) DO NOTHING
      RETURNING id
    `,
    [
      account.id,
      account.accountKey,
      messageId,
      remoteJid || "",
      senderJid || "",
      pushName || "",
      messageText || "",
      JSON.stringify(messageJson || {}),
      showCode || "",
      JSON.stringify(listenerWindow || {}),
      pricing?.manualWork ? null : pricing?.totalPrice || null,
      JSON.stringify(pricing?.breakdown || {}),
      Boolean(pricing?.manualWork),
      receivedAt
    ]
  );
  return result.rows[0] || null;
}

export async function listInboundWhatsappMessages({ accountId = 0, showCode = "", limit = 100 } = {}) {
  const result = await query(
    `
      SELECT
        id,
        account_id AS "accountId",
        account_key AS "accountKey",
        message_id AS "messageId",
        remote_jid AS "remoteJid",
        sender_jid AS "senderJid",
        push_name AS "pushName",
        message_text AS "messageText",
        calculated_price::TEXT AS "calculatedPrice",
        pricing_breakdown AS "pricingBreakdown",
        manual_work AS "manualWork",
        forwarded_at AS "forwardedAt",
        forwarded_to_jid AS "forwardedToJid",
        forwarded_by_payment_proof_id AS "forwardedByPaymentProofId",
        forward_error AS "forwardError",
        show_code AS "showCode",
        listener_window AS "listenerWindow",
        processing_status AS "processingStatus",
        received_at AS "receivedAt",
        created_at AS "createdAt"
      FROM whatsapp_inbound_messages
      WHERE ($1::BIGINT = 0 OR account_id = $1)
        AND ($2::TEXT = '' OR show_code = $2)
      ORDER BY received_at DESC
      LIMIT $3
    `,
    [accountId, showCode || "", Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );
  return result.rows;
}

export async function listForwardTargets() {
  const result = await query(
    `
      SELECT
        show_code AS "showCode",
        destination_jid AS "destinationJid",
        label,
        is_enabled AS "isEnabled",
        updated_at AS "updatedAt"
      FROM whatsapp_forward_targets
      ORDER BY show_code ASC
    `
  );
  return result.rows;
}

export async function upsertForwardTarget({ showCode, destinationJid = "", label = "", isEnabled = false }) {
  const safeShowCode = String(showCode || "").trim().toUpperCase();
  if (!safeShowCode) {
    throw new Error("showCode is required");
  }
  const result = await query(
    `
      INSERT INTO whatsapp_forward_targets (show_code, destination_jid, label, is_enabled)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (show_code) DO UPDATE SET
        destination_jid = EXCLUDED.destination_jid,
        label = EXCLUDED.label,
        is_enabled = EXCLUDED.is_enabled,
        updated_at = NOW()
      RETURNING
        show_code AS "showCode",
        destination_jid AS "destinationJid",
        label,
        is_enabled AS "isEnabled",
        updated_at AS "updatedAt"
    `,
    [safeShowCode, String(destinationJid || "").trim(), String(label || "").trim(), Boolean(isEnabled)]
  );
  return result.rows[0];
}

export async function upsertWhatsappChat({ account, jid, displayName = "", chatType = "chat", source = "" }) {
  if (!jid || jid === "status@broadcast") {
    return null;
  }
  const result = await query(
    `
      INSERT INTO whatsapp_chat_directory (
        account_id,
        account_key,
        jid,
        display_name,
        chat_type,
        source,
        last_seen_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (account_id, jid) DO UPDATE SET
        display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), whatsapp_chat_directory.display_name),
        chat_type = EXCLUDED.chat_type,
        source = EXCLUDED.source,
        last_seen_at = NOW(),
        updated_at = NOW()
      RETURNING
        jid,
        display_name AS "name",
        chat_type AS "type",
        source,
        last_seen_at AS "updatedAt"
    `,
    [
      account.id || null,
      account.accountKey || "",
      jid,
      displayName || jid,
      chatType === "group" ? "group" : "chat",
      source || ""
    ]
  );
  return result.rows[0] || null;
}

export async function listWhatsappChats({ accountId, search = "", limit = 300 }) {
  const result = await query(
    `
      SELECT
        jid,
        COALESCE(NULLIF(display_name, ''), jid) AS "name",
        chat_type AS "type",
        source,
        last_seen_at AS "updatedAt"
      FROM whatsapp_chat_directory
      WHERE account_id = $1
        AND (
          $2::TEXT = ''
          OR jid ILIKE '%' || $2 || '%'
          OR display_name ILIKE '%' || $2 || '%'
          OR chat_type ILIKE '%' || $2 || '%'
        )
      ORDER BY
        CASE WHEN chat_type = 'group' THEN 0 ELSE 1 END,
        display_name ASC,
        last_seen_at DESC
      LIMIT $3
    `,
    [accountId, String(search || "").trim(), Math.min(Math.max(Number(limit) || 300, 1), 500)]
  );
  return result.rows;
}

export async function listForwardableBookingsForProof({ accountId, remoteJid, senderJid, showCode = "", receivedAt }) {
  const result = await query(
    `
      SELECT
        m.id,
        m.account_id AS "accountId",
        m.account_key AS "accountKey",
        m.message_id AS "messageId",
        m.remote_jid AS "remoteJid",
        m.sender_jid AS "senderJid",
        m.push_name AS "pushName",
        m.message_json AS "messageJson",
        m.message_text AS "messageText",
        m.show_code AS "showCode",
        m.calculated_price::TEXT AS "calculatedPrice",
        t.destination_jid AS "destinationJid",
        t.label AS "destinationLabel"
      FROM whatsapp_inbound_messages m
      JOIN whatsapp_forward_targets t
        ON t.show_code = m.show_code
       AND t.is_enabled = TRUE
       AND t.destination_jid <> ''
      WHERE m.account_id = $1
        AND m.forwarded_at IS NULL
        AND m.manual_work = FALSE
        AND m.calculated_price IS NOT NULL
        AND ($4::TEXT = '' OR m.show_code = $4)
        AND m.received_at <= $5
        AND (
          m.remote_jid = $2
          OR m.sender_jid = $2
          OR m.remote_jid = $3
          OR m.sender_jid = $3
        )
      ORDER BY m.received_at ASC, m.id ASC
    `,
    [accountId, remoteJid || "", senderJid || "", showCode || "", receivedAt]
  );
  return result.rows;
}

export async function findForwardableBookingForProof(input) {
  const rows = await listForwardableBookingsForProof(input);
  return rows[rows.length - 1] || null;
}

export async function markBookingForwarded({ bookingId, paymentProofId, destinationJid }) {
  await query(
    `
      UPDATE whatsapp_inbound_messages
      SET
        forwarded_at = NOW(),
        forwarded_to_jid = $2,
        forwarded_by_payment_proof_id = $3,
        forward_error = ''
      WHERE id = $1
    `,
    [bookingId, destinationJid || "", paymentProofId || null]
  );
}

export async function markPaymentProofForwardResult({ proofId, bookingId = null, forwarded = false, error = "" }) {
  await query(
    `
      UPDATE whatsapp_payment_proofs
      SET
        matched_booking_id = COALESCE($2, matched_booking_id),
        forwarded_at = CASE WHEN $3 THEN NOW() ELSE forwarded_at END,
        forward_error = $4
      WHERE id = $1
    `,
    [proofId, bookingId, Boolean(forwarded), error || ""]
  );
}

export async function addCustomerPaymentBalance({
  accountId,
  remoteJid = "",
  senderJid = "",
  showCode = "",
  amount = 0,
  paymentProofId = null
}) {
  const result = await query(
    `
      INSERT INTO whatsapp_customer_payment_balances (
        account_id,
        remote_jid,
        sender_jid,
        show_code,
        balance_amount,
        last_payment_proof_id
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (account_id, remote_jid, sender_jid, show_code)
      DO UPDATE SET
        balance_amount = whatsapp_customer_payment_balances.balance_amount + EXCLUDED.balance_amount,
        last_payment_proof_id = EXCLUDED.last_payment_proof_id,
        updated_at = NOW()
      RETURNING balance_amount::TEXT AS "balanceAmount"
    `,
    [accountId, remoteJid || "", senderJid || "", showCode || "", amount || 0, paymentProofId]
  );
  return Number(result.rows[0]?.balanceAmount || 0);
}

export async function getCustomerPaymentBalance({
  accountId,
  remoteJid = "",
  senderJid = "",
  showCode = ""
}) {
  const result = await query(
    `
      SELECT balance_amount::TEXT AS "balanceAmount"
      FROM whatsapp_customer_payment_balances
      WHERE account_id = $1
        AND remote_jid = $2
        AND sender_jid = $3
        AND show_code = $4
      LIMIT 1
    `,
    [accountId, remoteJid || "", senderJid || "", showCode || ""]
  );
  return Number(result.rows[0]?.balanceAmount || 0);
}

export async function setCustomerPaymentBalance({
  accountId,
  remoteJid = "",
  senderJid = "",
  showCode = "",
  balance = 0,
  paymentProofId = null
}) {
  const result = await query(
    `
      INSERT INTO whatsapp_customer_payment_balances (
        account_id,
        remote_jid,
        sender_jid,
        show_code,
        balance_amount,
        last_payment_proof_id
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (account_id, remote_jid, sender_jid, show_code)
      DO UPDATE SET
        balance_amount = EXCLUDED.balance_amount,
        last_payment_proof_id = COALESCE(EXCLUDED.last_payment_proof_id, whatsapp_customer_payment_balances.last_payment_proof_id),
        updated_at = NOW()
      RETURNING balance_amount::TEXT AS "balanceAmount"
    `,
    [accountId, remoteJid || "", senderJid || "", showCode || "", Math.max(Number(balance || 0), 0), paymentProofId]
  );
  return Number(result.rows[0]?.balanceAmount || 0);
}

export async function deleteInboundWhatsappMessage(id) {
  const result = await query(
    `
      DELETE FROM whatsapp_inbound_messages
      WHERE id = $1
      RETURNING id
    `,
    [id]
  );
  return result.rows[0] || null;
}

export async function storeListenerEvent({
  account = {},
  eventType,
  detail = "",
  messageId = "",
  remoteJid = "",
  senderJid = "",
  messageText = ""
}) {
  await query(
    `
      INSERT INTO whatsapp_listener_events (
        account_id,
        account_key,
        event_type,
        detail,
        message_id,
        remote_jid,
        sender_jid,
        message_text
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      account.id || null,
      account.accountKey || "",
      eventType,
      detail,
      messageId,
      remoteJid,
      senderJid,
      messageText
    ]
  );
}

export async function listListenerEvents({ accountId = 0, limit = 100 } = {}) {
  const result = await query(
    `
      SELECT
        id,
        account_id AS "accountId",
        account_key AS "accountKey",
        event_type AS "eventType",
        detail,
        message_id AS "messageId",
        remote_jid AS "remoteJid",
        sender_jid AS "senderJid",
        message_text AS "messageText",
        created_at AS "createdAt"
      FROM whatsapp_listener_events
      WHERE ($1::BIGINT = 0 OR account_id = $1)
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [accountId, Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );
  return result.rows;
}

export async function listBookingStats({ days = 14 } = {}) {
  const result = await query(
    `
      WITH booking_stats AS (
        SELECT
          received_at::DATE AS stat_date,
          show_code,
          COUNT(*)::INTEGER AS booking_count,
          COALESCE(SUM(calculated_price), 0)::TEXT AS booking_amount,
          COALESCE(SUM(CASE WHEN manual_work THEN 1 ELSE 0 END), 0)::INTEGER AS manual_count
        FROM whatsapp_inbound_messages
        WHERE received_at >= CURRENT_DATE - (($1::INTEGER - 1) * INTERVAL '1 day')
        GROUP BY received_at::DATE, show_code
      ),
      winning_stats AS (
        SELECT
          sr.result_date AS stat_date,
          sr.game_show AS show_code,
          COUNT(wl.id)::INTEGER AS winner_count,
          COALESCE(SUM(wl.payout_amount), 0)::TEXT AS payout_amount
        FROM show_results sr
        LEFT JOIN winning_lines wl ON wl.show_result_id = sr.id
        WHERE sr.result_date >= CURRENT_DATE - (($1::INTEGER - 1) * INTERVAL '1 day')
        GROUP BY sr.result_date, sr.game_show
      )
      SELECT
        COALESCE(b.stat_date, w.stat_date) AS "date",
        COALESCE(b.show_code, w.show_code) AS "showCode",
        COALESCE(b.booking_count, 0)::INTEGER AS "bookingCount",
        COALESCE(b.booking_amount, '0') AS "bookingAmount",
        COALESCE(b.manual_count, 0)::INTEGER AS "manualCount",
        COALESCE(w.winner_count, 0)::INTEGER AS "winnerCount",
        COALESCE(w.payout_amount, '0') AS "payoutAmount"
      FROM booking_stats b
      FULL OUTER JOIN winning_stats w
        ON w.stat_date = b.stat_date
       AND w.show_code = b.show_code
      ORDER BY "date" DESC, "showCode" ASC
    `,
    [Math.min(Math.max(Number(days) || 14, 1), 90)]
  );
  return result.rows;
}

export async function listSupportSummary({ accountId = 0, limit = 200 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const balances = await query(
    `
      SELECT
        b.id,
        b.account_id AS "accountId",
        a.account_key AS "accountKey",
        a.display_name AS "accountName",
        b.remote_jid AS "remoteJid",
        b.sender_jid AS "senderJid",
        b.show_code AS "showCode",
        b.balance_amount::TEXT AS "balanceAmount",
        b.updated_at AS "updatedAt"
      FROM whatsapp_customer_payment_balances b
      JOIN whatsapp_listener_accounts a ON a.id = b.account_id
      WHERE b.balance_amount > 0
        AND ($1::BIGINT = 0 OR b.account_id = $1)
      ORDER BY b.updated_at DESC
      LIMIT $2
    `,
    [accountId, safeLimit]
  );

  const support = await query(
    `
      SELECT
        m.id,
        m.account_id AS "accountId",
        m.account_key AS "accountKey",
        a.display_name AS "accountName",
        m.remote_jid AS "remoteJid",
        m.sender_jid AS "senderJid",
        m.push_name AS "pushName",
        m.show_code AS "showCode",
        m.message_text AS "messageText",
        m.calculated_price::TEXT AS "calculatedPrice",
        m.manual_work AS "manualWork",
        m.forwarded_at AS "forwardedAt",
        m.forward_error AS "forwardError",
        m.received_at AS "receivedAt",
        COALESCE(b.balance_amount, 0)::TEXT AS "availableBalance",
        GREATEST(COALESCE(m.calculated_price, 0) - COALESCE(b.balance_amount, 0), 0)::TEXT AS "pendingAmount"
      FROM whatsapp_inbound_messages m
      JOIN whatsapp_listener_accounts a ON a.id = m.account_id
      LEFT JOIN whatsapp_customer_payment_balances b
        ON b.account_id = m.account_id
       AND b.remote_jid = m.remote_jid
       AND b.sender_jid = m.sender_jid
       AND b.show_code = m.show_code
      WHERE ($1::BIGINT = 0 OR m.account_id = $1)
        AND (
          m.manual_work = TRUE
          OR (
            m.forwarded_at IS NULL
            AND m.manual_work = FALSE
            AND m.calculated_price IS NOT NULL
          )
        )
      ORDER BY m.received_at DESC
      LIMIT $2
    `,
    [accountId, safeLimit]
  );

  const agents = await query(
    `
      SELECT
        m.account_id AS "accountId",
        m.account_key AS "accountKey",
        a.display_name AS "accountName",
        COUNT(*)::INTEGER AS "bookingCount",
        COUNT(DISTINCT COALESCE(NULLIF(m.sender_jid, ''), m.remote_jid))::INTEGER AS "customerCount",
        COALESCE(SUM(m.calculated_price), 0)::TEXT AS "bookingAmount",
        COUNT(*) FILTER (WHERE m.forwarded_at IS NOT NULL)::INTEGER AS "successCount",
        COUNT(*) FILTER (WHERE m.manual_work = TRUE)::INTEGER AS "manualCount",
        COUNT(*) FILTER (
          WHERE m.forwarded_at IS NULL
            AND m.manual_work = FALSE
            AND m.calculated_price IS NOT NULL
        )::INTEGER AS "paymentMissingCount"
      FROM whatsapp_inbound_messages m
      JOIN whatsapp_listener_accounts a ON a.id = m.account_id
      WHERE ($1::BIGINT = 0 OR m.account_id = $1)
      GROUP BY m.account_id, m.account_key, a.display_name
      ORDER BY "paymentMissingCount" DESC, "manualCount" DESC, "bookingCount" DESC
    `,
    [accountId]
  );

  const kpis = await query(
    `
      SELECT
        COUNT(*) FILTER (WHERE forwarded_at IS NOT NULL)::INTEGER AS "successfulBookings",
        COUNT(*) FILTER (
          WHERE forwarded_at IS NULL
            AND manual_work = FALSE
            AND calculated_price IS NOT NULL
        )::INTEGER AS "paymentMissingBookings",
        COUNT(*) FILTER (WHERE manual_work = TRUE)::INTEGER AS "manualSupportBookings"
      FROM whatsapp_inbound_messages
      WHERE ($1::BIGINT = 0 OR account_id = $1)
    `,
    [accountId]
  );

  return {
    kpis: {
      ...kpis.rows[0],
      customersWithBalance: balances.rows.length
    },
    balances: balances.rows,
    support: support.rows,
    agents: agents.rows
  };
}

export async function storeWhatsappPaymentProof({
  account,
  messageId,
  remoteJid,
  senderJid,
  pushName,
  mediaType,
  filePath,
  ocrText,
  proof,
  status,
  matchedCreditId = null,
  receivedAt
}) {
  const result = await query(
    `
      INSERT INTO whatsapp_payment_proofs (
        account_id,
        account_key,
        message_id,
        remote_jid,
        sender_jid,
        push_name,
        media_type,
        file_path,
        ocr_text,
        proof_json,
        amount,
        transaction_id,
        utr,
        status,
        matched_credit_id,
        received_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (account_id, message_id) DO UPDATE SET
        ocr_text = EXCLUDED.ocr_text,
        proof_json = EXCLUDED.proof_json,
        amount = EXCLUDED.amount,
        transaction_id = EXCLUDED.transaction_id,
        utr = EXCLUDED.utr,
        status = EXCLUDED.status,
        matched_credit_id = EXCLUDED.matched_credit_id
      RETURNING id
    `,
    [
      account.id || null,
      account.accountKey || "",
      messageId,
      remoteJid || "",
      senderJid || "",
      pushName || "",
      mediaType || "",
      filePath || "",
      ocrText || "",
      JSON.stringify(proof || {}),
      proof?.amount || null,
      proof?.transactionId || "",
      proof?.utr || "",
      status || "parsed",
      matchedCreditId,
      receivedAt
    ]
  );
  return result.rows[0] || null;
}

export async function listWhatsappPaymentProofs({ accountId = 0, limit = 100 } = {}) {
  const result = await query(
    `
      SELECT
        id,
        account_id AS "accountId",
        account_key AS "accountKey",
        message_id AS "messageId",
        remote_jid AS "remoteJid",
        sender_jid AS "senderJid",
        push_name AS "pushName",
        media_type AS "mediaType",
        file_path AS "filePath",
        ocr_text AS "ocrText",
        proof_json AS "proof",
        amount::TEXT,
        transaction_id AS "transactionId",
        utr,
        status,
        matched_credit_id AS "matchedCreditId",
        matched_booking_id AS "matchedBookingId",
        forwarded_at AS "forwardedAt",
        forward_error AS "forwardError",
        received_at AS "receivedAt",
        created_at AS "createdAt"
      FROM whatsapp_payment_proofs
      WHERE ($1::BIGINT = 0 OR account_id = $1)
      ORDER BY received_at DESC
      LIMIT $2
    `,
    [accountId, Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );
  return result.rows;
}

export function normalizeAccountKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}
