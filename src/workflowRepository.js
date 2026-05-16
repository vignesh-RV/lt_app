import { pool, query } from "./db.js";
import { calculatePredictionPricing } from "./gamePricing.js";

export async function upsertCustomer({ whatsappSender, displayName = "", phoneNumber = "" }) {
  const result = await query(
    `
      INSERT INTO customers (whatsapp_sender, display_name, phone_number)
      VALUES ($1, $2, $3)
      ON CONFLICT (whatsapp_sender) DO UPDATE SET
        display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), customers.display_name),
        phone_number = COALESCE(NULLIF(EXCLUDED.phone_number, ''), customers.phone_number),
        updated_at = NOW()
      RETURNING id, whatsapp_sender AS "whatsappSender", display_name AS "displayName", phone_number AS "phoneNumber"
    `,
    [whatsappSender, displayName, phoneNumber]
  );
  return result.rows[0];
}

export async function findPricingRule(messageText) {
  const rules = await query(
    `
      SELECT id, name, match_type AS "matchType", pattern, price::TEXT
      FROM prediction_pricing_rules
      WHERE is_active = TRUE
      ORDER BY priority ASC, id ASC
    `
  );

  const lower = messageText.toLowerCase();
  return rules.rows.find((rule) => {
    if (rule.matchType === "contains") {
      return lower.includes(rule.pattern.toLowerCase());
    }
    try {
      return new RegExp(rule.pattern, "i").test(messageText);
    } catch {
      return false;
    }
  }) || null;
}

export async function createPredictionRequest({ customer, rawText, messageSource, receivedAt }) {
  const pricing = await calculatePredictionPricing(rawText, receivedAt);
  const status = pricing?.manualWork ? "manual_work" : (pricing ? "pending_payment" : "ignored");
  const result = await query(
    `
      INSERT INTO prediction_requests (
        customer_id,
        message_source,
        whatsapp_sender,
        raw_text,
        matched_rule_id,
        calculated_price,
        game_pricing_rule_id,
        game_show,
        market,
        game_type,
        unit_price,
        quantity,
        parsed_numbers,
        pricing_breakdown,
        status,
        received_at
      )
      VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING
        id,
        customer_id AS "customerId",
        message_source AS "messageSource",
        whatsapp_sender AS "whatsappSender",
        raw_text AS "rawText",
        matched_rule_id AS "matchedRuleId",
        game_pricing_rule_id AS "gamePricingRuleId",
        calculated_price::TEXT AS "calculatedPrice",
        game_show AS "gameShow",
        market,
        game_type AS "gameType",
        unit_price::TEXT AS "unitPrice",
        quantity,
        parsed_numbers AS "parsedNumbers",
        pricing_breakdown AS "pricingBreakdown",
        status,
        received_at AS "receivedAt"
    `,
    [
      customer.id,
      messageSource,
      customer.whatsappSender,
      rawText,
      pricing && !pricing.manualWork ? pricing.totalPrice : null,
      pricing?.rule?.id || null,
      pricing ? pricing.show.code : null,
      pricing ? pricing.market : null,
      pricing ? pricing.gameType : null,
      pricing && !pricing.manualWork ? pricing.unitPrice : null,
      pricing && !pricing.manualWork ? pricing.quantity : null,
      JSON.stringify(pricing ? pricing.numbers : []),
      JSON.stringify(pricing ? pricing.breakdown : {}),
      status,
      receivedAt
    ]
  );

  return { predictionRequest: result.rows[0], matchedRule: pricing ? pricing.rule : null };
}

export async function createOutboundMessage({ customerId, predictionRequestId, whatsappSender, messageText }) {
  const result = await query(
    `
      INSERT INTO outbound_messages (customer_id, prediction_request_id, whatsapp_sender, message_text)
      VALUES ($1, $2, $3, $4)
      RETURNING id, whatsapp_sender AS "whatsappSender", message_text AS "messageText", status, created_at AS "createdAt"
    `,
    [customerId, predictionRequestId, whatsappSender, messageText]
  );
  return result.rows[0];
}

export async function findCreditForProof({ transactionId, amount }) {
  if (transactionId) {
    const byTransaction = await query(
      `
        SELECT id, amount::TEXT, transaction_id AS "transactionId", unique_id AS "uniqueId"
        FROM bank_credit_messages
        WHERE transaction_id = $1 OR unique_id = $1
        ORDER BY received_at DESC
        LIMIT 1
      `,
      [transactionId]
    );
    if (byTransaction.rowCount > 0) {
      return byTransaction.rows[0];
    }
  }

  const byAmount = await query(
    `
      SELECT id, amount::TEXT, transaction_id AS "transactionId", unique_id AS "uniqueId"
      FROM bank_credit_messages
      WHERE amount = $1
      ORDER BY received_at DESC
      LIMIT 1
    `,
    [amount]
  );
  return byAmount.rows[0] || null;
}

export async function reconcilePaymentProof(input) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const customerResult = await client.query(
      `
        INSERT INTO customers (whatsapp_sender, display_name, phone_number)
        VALUES ($1, $2, $3)
        ON CONFLICT (whatsapp_sender) DO UPDATE SET
          display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), customers.display_name),
          phone_number = COALESCE(NULLIF(EXCLUDED.phone_number, ''), customers.phone_number),
          updated_at = NOW()
        RETURNING id, whatsapp_sender AS "whatsappSender"
      `,
      [input.whatsappSender, input.displayName || "", input.phoneNumber || ""]
    );
    const customer = customerResult.rows[0];

    const requestResult = await client.query(
      `
        SELECT id, calculated_price::NUMERIC AS calculated_price, status
        FROM prediction_requests
        WHERE id = $1 AND customer_id = $2
        FOR UPDATE
      `,
      [input.predictionRequestId, customer.id]
    );

    if (requestResult.rowCount === 0) {
      throw new Error("Prediction request not found for this customer");
    }

    const request = requestResult.rows[0];
    const requiredAmount = Number(request.calculated_price || 0);
    const paidAmount = Number(input.amount);
    const matchedCredit = await findCreditForProofWithClient(client, input);

    const proofStatus = matchedCredit
      ? (Number(matchedCredit.amount) === paidAmount ? "matched" : "amount_mismatch")
      : "not_found";

    const proofResult = await client.query(
      `
        INSERT INTO payment_proofs (
          customer_id,
          prediction_request_id,
          amount,
          transaction_id,
          transaction_date_text,
          screenshot_path,
          raw_text,
          status,
          matched_credit_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, status
      `,
      [
        customer.id,
        input.predictionRequestId,
        paidAmount,
        input.transactionId || "",
        input.transactionDateText || "",
        input.screenshotPath || "",
        input.rawText || "",
        proofStatus,
        matchedCredit ? matchedCredit.id : null
      ]
    );

    const utilizedAmount = Math.min(requiredAmount, paidAmount);
    const balanceAmount = Math.max(paidAmount - requiredAmount, 0);
    const utilizationStatus = paidAmount >= requiredAmount
      ? (balanceAmount > 0 ? "balance_available" : "fully_utilized")
      : "partial";
    const requestStatus = paidAmount >= requiredAmount
      ? (balanceAmount > 0 ? "overpaid" : "paid")
      : "partial_payment";

    const utilizationResult = await client.query(
      `
        INSERT INTO payment_utilizations (
          customer_id,
          prediction_request_id,
          credit_message_id,
          payment_proof_id,
          required_amount,
          paid_amount,
          utilized_amount,
          balance_amount,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, required_amount::TEXT AS "requiredAmount", paid_amount::TEXT AS "paidAmount",
          utilized_amount::TEXT AS "utilizedAmount", balance_amount::TEXT AS "balanceAmount", status
      `,
      [
        customer.id,
        input.predictionRequestId,
        matchedCredit ? matchedCredit.id : null,
        proofResult.rows[0].id,
        requiredAmount,
        paidAmount,
        utilizedAmount,
        balanceAmount,
        utilizationStatus
      ]
    );

    await client.query(
      `
        INSERT INTO customer_balances (customer_id, balance_amount)
        VALUES ($1, $2)
        ON CONFLICT (customer_id) DO UPDATE SET
          balance_amount = customer_balances.balance_amount + EXCLUDED.balance_amount,
          updated_at = NOW()
      `,
      [customer.id, balanceAmount]
    );

    await client.query(
      "UPDATE prediction_requests SET status = $1, updated_at = NOW() WHERE id = $2",
      [requestStatus, input.predictionRequestId]
    );

    let outboundMessage = null;
    if (paidAmount < requiredAmount) {
      const pending = (requiredAmount - paidAmount).toFixed(2);
      const messageText = `Payment received Rs ${paidAmount.toFixed(2)}, but required amount is Rs ${requiredAmount.toFixed(2)}. Please pay pending Rs ${pending}.`;
      const outbound = await client.query(
        `
          INSERT INTO outbound_messages (customer_id, prediction_request_id, whatsapp_sender, message_text)
          VALUES ($1, $2, $3, $4)
          RETURNING id, message_text AS "messageText", status
        `,
        [customer.id, input.predictionRequestId, input.whatsappSender, messageText]
      );
      outboundMessage = outbound.rows[0];
    }

    await client.query("COMMIT");

    return {
      customer,
      matchedCredit,
      proof: proofResult.rows[0],
      utilization: utilizationResult.rows[0],
      outboundMessage
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function findCreditForProofWithClient(client, { transactionId, amount }) {
  if (transactionId) {
    const result = await client.query(
      `
        SELECT id, amount::TEXT, transaction_id AS "transactionId", unique_id AS "uniqueId"
        FROM bank_credit_messages
        WHERE transaction_id = $1 OR unique_id = $1
        ORDER BY received_at DESC
        LIMIT 1
      `,
      [transactionId]
    );
    if (result.rowCount > 0) {
      return result.rows[0];
    }
  }

  const result = await client.query(
    `
      SELECT id, amount::TEXT, transaction_id AS "transactionId", unique_id AS "uniqueId"
      FROM bank_credit_messages
      WHERE amount = $1
      ORDER BY received_at DESC
      LIMIT 1
    `,
    [amount]
  );
  return result.rows[0] || null;
}
