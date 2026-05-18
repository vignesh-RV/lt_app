export function logInfo(event, details = {}) {
  console.log(JSON.stringify(logPayload("info", event, details)));
}

export function logWarn(event, details = {}) {
  console.warn(JSON.stringify(logPayload("warn", event, details)));
}

export function logError(event, error, details = {}) {
  console.error(JSON.stringify(logPayload("error", event, {
    ...details,
    error: serializeError(error)
  })));
}

export function serializeError(error) {
  if (!error) {
    return null;
  }
  return {
    name: error.name || "",
    message: error.message || String(error),
    code: error.code || "",
    signal: error.signal || "",
    errno: error.errno || "",
    syscall: error.syscall || "",
    path: error.path || "",
    statusCode: error.statusCode || error.status || "",
    stdout: trimLogText(error.stdout || ""),
    stderr: trimLogText(error.stderr || ""),
    stack: trimLogText(error.stack || "", 3000)
  };
}

function logPayload(level, event, details) {
  return {
    level,
    event,
    at: new Date().toISOString(),
    ...details
  };
}

function trimLogText(value, maxLength = 1200) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
