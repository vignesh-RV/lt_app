const VALID_SOURCES = new Set(["SMS", "Gmail", "WhatsApp", "WhatsApp Business"]);

export function validateCreditPayload(body) {
  const errors = [];
  const direction = stringValue(body.direction || "credit").toLowerCase();
  const messageSource = stringValue(body.messageSource || body.source);
  const source = stringValue(body.source || messageSource);
  const amount = stringValue(body.amount);
  const rawText = stringValue(body.rawText);
  const timestamp = Number(body.timestamp || Date.now());
  const uniqueId = stringValue(body.uniqueId || body.transactionId);

  if (direction !== "credit") {
    errors.push("direction must be credit");
  }
  if (!VALID_SOURCES.has(messageSource)) {
    errors.push("messageSource must be SMS, Gmail, WhatsApp, or WhatsApp Business");
  }
  if (!amount || !/^\d+(\.\d{1,2})?$/.test(amount)) {
    errors.push("amount is required and must be a valid number");
  }
  if (!rawText) {
    errors.push("rawText is required");
  }
  if (!uniqueId) {
    errors.push("uniqueId or transactionId is required");
  }
  if (!Number.isFinite(timestamp)) {
    errors.push("timestamp must be a Unix timestamp in milliseconds");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    credit: {
      uniqueId,
      messageSource,
      source,
      appPackage: stringValue(body.appPackage),
      amount,
      sender: stringValue(body.sender),
      transactionDateText: stringValue(body.transactionDateText),
      payerName: stringValue(body.payerName),
      payerVpa: stringValue(body.payerVpa),
      accountHint: stringValue(body.accountHint),
      transactionId: stringValue(body.transactionId),
      deviceId: stringValue(body.deviceId),
      deviceName: stringValue(body.deviceName),
      deviceManufacturer: stringValue(body.deviceManufacturer),
      deviceModel: stringValue(body.deviceModel),
      phoneNumbers: Array.isArray(body.phoneNumbers)
        ? body.phoneNumbers.map(stringValue).filter(Boolean)
        : [],
      receivedPhoneNumber: stringValue(body.receivedPhoneNumber),
      smsSubscriptionId: stringValue(body.smsSubscriptionId),
      rawText,
      receivedAt: new Date(timestamp),
      payload: body
    }
  };
}

function stringValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}
