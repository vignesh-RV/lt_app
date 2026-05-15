import { pool, query } from "./db.js";

export async function upsertShowResultAndCalculateWinners(input) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        INSERT INTO show_results (
          result_date,
          game_show,
          market,
          winning_number,
          entered_by,
          notes
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (result_date, game_show) DO UPDATE SET
          market = EXCLUDED.market,
          winning_number = EXCLUDED.winning_number,
          entered_by = EXCLUDED.entered_by,
          notes = EXCLUDED.notes,
          updated_at = NOW()
        RETURNING
          id,
          result_date AS "resultDate",
          game_show AS "gameShow",
          market,
          winning_number AS "winningNumber",
          entered_by AS "enteredBy",
          notes,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        input.resultDate,
        input.gameShow,
        input.market,
        input.winningNumber,
        input.enteredBy || "",
        input.notes || ""
      ]
    );

    const showResult = result.rows[0];
    await client.query("DELETE FROM winning_lines WHERE show_result_id = $1", [showResult.id]);

    const requests = await client.query(
      `
        SELECT
          pr.id,
          pr.customer_id AS "customerId",
          pr.pricing_breakdown AS "pricingBreakdown",
          c.whatsapp_sender AS "whatsappSender",
          c.display_name AS "displayName"
        FROM prediction_requests pr
        JOIN customers c ON c.id = pr.customer_id
        WHERE pr.game_show = $1
          AND pr.market = $2
          AND pr.status IN ('pending_payment', 'paid', 'partial_payment', 'overpaid')
      `,
      [input.gameShow, input.market]
    );

    const winners = [];
    for (const request of requests.rows) {
      const entries = Array.isArray(request.pricingBreakdown?.entries)
        ? request.pricingBreakdown.entries
        : [];
      for (let i = 0; i < entries.length; i++) {
        const match = calculateEntryWin(entries[i], input.winningNumber);
        if (!match) {
          continue;
        }

        const insert = await client.query(
          `
            INSERT INTO winning_lines (
              show_result_id,
              prediction_request_id,
              customer_id,
              entry_index,
              raw_line,
              game_mode,
              matched_tier,
              predicted_number,
              normalized_number,
              winning_number,
              unit_price,
              units,
              win_amount_per_unit,
              payout_amount
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING
              id,
              prediction_request_id AS "predictionRequestId",
              customer_id AS "customerId",
              raw_line AS "rawLine",
              game_mode AS "gameMode",
              matched_tier AS "matchedTier",
              predicted_number AS "predictedNumber",
              normalized_number AS "normalizedNumber",
              winning_number AS "winningNumber",
              unit_price::TEXT AS "unitPrice",
              units,
              win_amount_per_unit::TEXT AS "winAmountPerUnit",
              payout_amount::TEXT AS "payoutAmount",
              status
          `,
          [
            showResult.id,
            request.id,
            request.customerId,
            i,
            entries[i].rawLine || "",
            entries[i].gameMode || "",
            match.tier,
            match.predictedNumber,
            entries[i].normalizedNumber || match.predictedNumber,
            input.winningNumber,
            Number(entries[i].unitPrice || 0),
            Number(entries[i].setCount || entries[i].units || 1),
            match.amountPerUnit,
            match.payoutAmount
          ]
        );
        winners.push({
          ...insert.rows[0],
          whatsappSender: request.whatsappSender,
          displayName: request.displayName
        });
      }
    }

    await client.query("COMMIT");
    return { showResult, winners };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listShowResults(limit) {
  const result = await query(
    `
      SELECT
        sr.id,
        sr.result_date AS "resultDate",
        sr.game_show AS "gameShow",
        sr.market,
        sr.winning_number AS "winningNumber",
        sr.entered_by AS "enteredBy",
        sr.notes,
        COALESCE(COUNT(wl.id), 0)::INTEGER AS "winnerCount",
        COALESCE(SUM(wl.payout_amount), 0)::TEXT AS "totalPayout",
        sr.created_at AS "createdAt",
        sr.updated_at AS "updatedAt"
      FROM show_results sr
      LEFT JOIN winning_lines wl ON wl.show_result_id = sr.id
      GROUP BY sr.id
      ORDER BY sr.result_date DESC, sr.created_at DESC
      LIMIT $1
    `,
    [limit]
  );
  return result.rows;
}

export async function listWinners({ showResultId, status, limit }) {
  const params = [];
  const filters = [];
  if (showResultId) {
    params.push(showResultId);
    filters.push(`wl.show_result_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    filters.push(`wl.status = $${params.length}`);
  }
  params.push(limit);

  const result = await query(
    `
      SELECT
        wl.id,
        wl.show_result_id AS "showResultId",
        wl.prediction_request_id AS "predictionRequestId",
        wl.customer_id AS "customerId",
        c.whatsapp_sender AS "whatsappSender",
        c.display_name AS "displayName",
        wl.raw_line AS "rawLine",
        wl.game_mode AS "gameMode",
        wl.matched_tier AS "matchedTier",
        wl.predicted_number AS "predictedNumber",
        wl.normalized_number AS "normalizedNumber",
        wl.winning_number AS "winningNumber",
        wl.unit_price::TEXT AS "unitPrice",
        wl.units,
        wl.win_amount_per_unit::TEXT AS "winAmountPerUnit",
        wl.payout_amount::TEXT AS "payoutAmount",
        wl.status,
        wl.disbursed_at AS "disbursedAt",
        wl.disbursement_reference AS "disbursementReference",
        wl.disbursement_notes AS "disbursementNotes",
        wl.created_at AS "createdAt"
      FROM winning_lines wl
      JOIN customers c ON c.id = wl.customer_id
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY wl.created_at DESC, wl.id DESC
      LIMIT $${params.length}
    `,
    params
  );
  return result.rows;
}

export async function markWinnerDisbursed({ winnerId, reference, notes }) {
  const result = await query(
    `
      UPDATE winning_lines
      SET
        status = 'disbursed',
        disbursed_at = NOW(),
        disbursement_reference = $2,
        disbursement_notes = $3,
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        status,
        disbursed_at AS "disbursedAt",
        disbursement_reference AS "disbursementReference",
        disbursement_notes AS "disbursementNotes"
    `,
    [winnerId, reference || "", notes || ""]
  );
  return result.rows[0] || null;
}

function calculateEntryWin(entry, winningNumber) {
  const win = String(winningNumber || "");
  const predictedNumbers = Array.isArray(entry.numbers) ? entry.numbers : [];
  const winTiers = entry.winTiers || {};
  const candidates = buildCandidates(entry, predictedNumbers);

  const tierOrder = ["ABCD", "ABC", "ACB", "BAC", "BCA", "CAB", "CBA", "AB", "AC", "BC", "A", "B", "C", "single"];
  for (const tier of tierOrder) {
    if (winTiers[tier] === undefined) {
      continue;
    }
    const expected = winningSlice(win, tier);
    if (!expected) {
      continue;
    }
    const matched = candidates.find((candidate) => candidate.tier === tier && candidate.value === expected);
    if (!matched) {
      continue;
    }
    const amountPerUnit = Number(winTiers[tier]);
    const units = Number(entry.setCount || entry.units || 1);
    return {
      tier,
      predictedNumber: matched.value,
      amountPerUnit,
      payoutAmount: amountPerUnit * units
    };
  }

  return null;
}

function buildCandidates(entry, predictedNumbers) {
  const mode = entry.gameMode || "";
  const boards = Array.isArray(entry.expandedBoards) ? entry.expandedBoards : [];
  const candidates = [];

  for (const number of predictedNumbers) {
    if (mode === "BOX") {
      for (const board of boards) {
        candidates.push({ tier: board.length === 3 ? "ABC" : board, value: number });
      }
      continue;
    }
    if (mode === "ALL") {
      for (const board of boards) {
        candidates.push({ tier: board, value: number });
      }
      continue;
    }
    if (mode === "DIRECT") {
      candidates.push({ tier: number.length === 4 ? "ABCD" : number.length === 3 ? "ABC" : number.length === 2 ? "BC" : "single", value: number });
      continue;
    }
    candidates.push({ tier: mode, value: number });
  }

  return candidates;
}

function winningSlice(winningNumber, tier) {
  const padded = winningNumber.padStart(4, "0");
  const d = padded[0];
  const a = padded[1];
  const b = padded[2];
  const c = padded[3];
  const values = {
    ABCD: `${a}${b}${c}${d}`,
    ABC: `${a}${b}${c}`,
    ACB: `${a}${c}${b}`,
    BAC: `${b}${a}${c}`,
    BCA: `${b}${c}${a}`,
    CAB: `${c}${a}${b}`,
    CBA: `${c}${b}${a}`,
    AB: `${a}${b}`,
    AC: `${a}${c}`,
    BC: `${b}${c}`,
    A: a,
    B: b,
    C: c,
    single: c
  };
  return values[tier] || "";
}
