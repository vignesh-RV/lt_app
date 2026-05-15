import { query } from "./db.js";

export async function upsertCredit(credit) {
  const result = await query(
    `
      INSERT INTO bank_credit_messages (
        unique_id,
        message_source,
        source,
        app_package,
        direction,
        amount,
        sender,
        transaction_date_text,
        payer_name,
        payer_vpa,
        account_hint,
        transaction_id,
        device_id,
        device_name,
        device_manufacturer,
        device_model,
        phone_numbers,
        received_phone_number,
        sms_subscription_id,
        raw_text,
        payload,
        received_at
      )
      VALUES (
        $1, $2, $3, $4, 'credit', $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
      )
      ON CONFLICT (unique_id) DO UPDATE SET
        message_source = EXCLUDED.message_source,
        source = EXCLUDED.source,
        app_package = EXCLUDED.app_package,
        amount = EXCLUDED.amount,
        sender = EXCLUDED.sender,
        transaction_date_text = EXCLUDED.transaction_date_text,
        payer_name = EXCLUDED.payer_name,
        payer_vpa = EXCLUDED.payer_vpa,
        account_hint = EXCLUDED.account_hint,
        transaction_id = EXCLUDED.transaction_id,
        device_id = EXCLUDED.device_id,
        device_name = EXCLUDED.device_name,
        device_manufacturer = EXCLUDED.device_manufacturer,
        device_model = EXCLUDED.device_model,
        phone_numbers = EXCLUDED.phone_numbers,
        received_phone_number = EXCLUDED.received_phone_number,
        sms_subscription_id = EXCLUDED.sms_subscription_id,
        raw_text = EXCLUDED.raw_text,
        payload = EXCLUDED.payload,
        received_at = EXCLUDED.received_at,
        updated_at = NOW()
      RETURNING
        id,
        unique_id AS "uniqueId",
        message_source AS "messageSource",
        source,
        app_package AS "appPackage",
        direction,
        amount::TEXT,
        sender,
        transaction_date_text AS "transactionDateText",
        payer_name AS "payerName",
        payer_vpa AS "payerVpa",
        account_hint AS "accountHint",
        transaction_id AS "transactionId",
        device_id AS "deviceId",
        device_name AS "deviceName",
        device_manufacturer AS "deviceManufacturer",
        device_model AS "deviceModel",
        phone_numbers AS "phoneNumbers",
        received_phone_number AS "receivedPhoneNumber",
        sms_subscription_id AS "smsSubscriptionId",
        raw_text AS "rawText",
        received_at AS "receivedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
    [
      credit.uniqueId,
      credit.messageSource,
      credit.source,
      credit.appPackage,
      credit.amount,
      credit.sender,
      credit.transactionDateText,
      credit.payerName,
      credit.payerVpa,
      credit.accountHint,
      credit.transactionId,
      credit.deviceId,
      credit.deviceName,
      credit.deviceManufacturer,
      credit.deviceModel,
      JSON.stringify(credit.phoneNumbers),
      credit.receivedPhoneNumber,
      credit.smsSubscriptionId,
      credit.rawText,
      JSON.stringify(credit.payload),
      credit.receivedAt
    ]
  );

  return result.rows[0];
}

export async function listCredits(limit) {
  const result = await query(
    `
      SELECT
        id,
        unique_id AS "uniqueId",
        message_source AS "messageSource",
        source,
        app_package AS "appPackage",
        direction,
        amount::TEXT,
        sender,
        transaction_date_text AS "transactionDateText",
        payer_name AS "payerName",
        payer_vpa AS "payerVpa",
        account_hint AS "accountHint",
        transaction_id AS "transactionId",
        device_id AS "deviceId",
        device_name AS "deviceName",
        device_manufacturer AS "deviceManufacturer",
        device_model AS "deviceModel",
        phone_numbers AS "phoneNumbers",
        received_phone_number AS "receivedPhoneNumber",
        sms_subscription_id AS "smsSubscriptionId",
        raw_text AS "rawText",
        received_at AS "receivedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM bank_credit_messages
      ORDER BY received_at DESC, id DESC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows;
}
