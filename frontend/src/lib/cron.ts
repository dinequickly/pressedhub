// Render a 5-field cron in plain English when we recognize the pattern,
// otherwise fall back to the raw expression.
export function humanCron(cron: string, tz: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `${cron} (${tz})`;
  const [m, h, , , dow] = parts;
  const time = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  if (h === "*" && dow === "*") return `Every hour at :${m.padStart(2, "0")}`;
  if (dow === "*") return `Daily at ${time} ${tz}`;
  if (dow === "1-5") return `Weekdays at ${time} ${tz}`;
  if (/^\d$/.test(dow)) {
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parseInt(dow)];
    return `${day} at ${time} ${tz}`;
  }
  return `${cron} (${tz})`;
}
