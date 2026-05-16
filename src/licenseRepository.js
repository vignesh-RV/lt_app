import { query } from "./db.js";

export async function checkAppLicense({ deviceId = "", phoneNumbers = [] }) {
  const normalizedNumbers = [...new Set(phoneNumbers.map(normalizeMobile).filter(Boolean))];
  const safeDeviceId = String(deviceId || "").trim();

  if (normalizedNumbers.length === 0 && !safeDeviceId) {
    return denied("No phone number or device id was provided.");
  }

  const result = await query(
    `
      SELECT
        id,
        customer_name AS "customerName",
        mobile_number AS "mobileNumber",
        normalized_mobile AS "normalizedMobile",
        device_id AS "deviceId",
        status,
        expires_at AS "expiresAt"
      FROM app_licenses
      WHERE normalized_mobile = ANY($1::TEXT[])
        OR ($2 <> '' AND device_id = $2)
      ORDER BY
        CASE WHEN $2 <> '' AND device_id = $2 THEN 0 ELSE 1 END,
        id ASC
      LIMIT 1
    `,
    [normalizedNumbers, safeDeviceId]
  );

  const license = result.rows[0];
  if (!license) {
    return denied("This mobile/device is not licensed.");
  }
  if (license.status !== "active") {
    return denied(`License is ${license.status}.`, license);
  }
  if (license.expiresAt && new Date(license.expiresAt).getTime() < Date.now()) {
    return denied("License expired.", license);
  }
  if (license.deviceId && safeDeviceId && license.deviceId !== safeDeviceId) {
    return denied("License is linked to another device.", license);
  }

  if (!license.deviceId && safeDeviceId) {
    await query(
      `
        UPDATE app_licenses
        SET device_id = $1, last_seen_at = NOW(), updated_at = NOW()
        WHERE id = $2
      `,
      [safeDeviceId, license.id]
    );
    license.deviceId = safeDeviceId;
  } else {
    await query("UPDATE app_licenses SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1", [license.id]);
  }

  return {
    allowed: true,
    mode: "full",
    reason: "Licensed.",
    license
  };
}

export function normalizeMobile(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (digits.length > 10 && digits.startsWith("91")) {
    return digits.slice(-10);
  }
  return digits;
}

function denied(reason, license = null) {
  return {
    allowed: false,
    mode: "calculator_only",
    reason,
    license
  };
}
