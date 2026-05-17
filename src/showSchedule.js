const IST_OFFSET_MINUTES = 5 * 60 + 30;

const SHOW_BOOKING_WINDOWS = [
  { code: "1PM_DEAR", market: "Dear", cutoffHour: 12, cutoffMinute: 57 },
  { code: "3PM_KL", market: "Kerala", cutoffHour: 15, cutoffMinute: 2 },
  { code: "6PM_DEAR", market: "Dear", cutoffHour: 17, cutoffMinute: 57 },
  { code: "8PM_DEAR", market: "Dear", cutoffHour: 19, cutoffMinute: 57 }
];

export function isShowWindowActive(showCode, at = new Date()) {
  const window = activeBookingWindow(at);
  return Boolean(window.active && window.showCode === showCode);
}

export function activeBookingWindow(at = new Date()) {
  const ist = toIstParts(at);
  const currentMinutes = ist.hour * 60 + ist.minute;

  for (const show of SHOW_BOOKING_WINDOWS) {
    const cutoffMinutes = show.cutoffHour * 60 + show.cutoffMinute;
    const openMinutes = cutoffMinutes - 60;
    if (currentMinutes >= openMinutes && currentMinutes <= cutoffMinutes) {
      return {
        active: true,
        showCode: show.code,
        market: show.market,
        openTime: formatMinutes(openMinutes),
        cutoffTime: formatMinutes(cutoffMinutes),
        timezone: "Asia/Kolkata"
      };
    }
  }

  return {
    active: false,
    showCode: "",
    market: "",
    timezone: "Asia/Kolkata"
  };
}

function toIstParts(date) {
  const istMillis = date.getTime() + IST_OFFSET_MINUTES * 60 * 1000;
  const ist = new Date(istMillis);
  return {
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes()
  };
}

function formatMinutes(value) {
  const hour24 = Math.floor(value / 60);
  const minute = value % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${String(hour12).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${suffix}`;
}
