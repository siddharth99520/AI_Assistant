/**
 * logger.js — Shared persistent logging utility
 *
 * Stores logs in chrome.storage.local so they survive stealth mode
 * and extension reloads, allowing users to inspect failures later.
 */

const MAX_LOGS = 50;
const STORAGE_KEY = "mcq_ai_stealth_logs";

/**
 * @typedef {Object} LogEntry
 * @property {string} timestamp
 * @property {string} level - "INFO", "WARN", "ERROR"
 * @property {string} context - e.g., "SW", "Content", "Popup"
 * @property {string} message
 * @property {any} [details]
 */

/**
 * Appends a log entry to local storage.
 * @param {string} level
 * @param {string} context
 * @param {string} message
 * @param {any} [details]
 */
async function appendLog(level, context, message, details = null) {
  let serializedDetails = null;
  if (details instanceof Error) {
    serializedDetails = { message: details.message, name: details.name, stack: details.stack };
  } else if (details !== undefined && details !== null) {
    try {
      serializedDetails = JSON.parse(JSON.stringify(details));
    } catch {
      serializedDetails = String(details);
    }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    context,
    message,
    details: serializedDetails
  };

  // Also log to standard console
  const consoleMsg = `[${context}] ${message}`;
  if (level === "ERROR") console.error(consoleMsg, details || "");
  else if (level === "WARN") console.warn(consoleMsg, details || "");
  else console.info(consoleMsg, details || "");

  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const logs = data[STORAGE_KEY] || [];
    
    logs.push(entry);
    
    // Keep only the most recent MAX_LOGS
    if (logs.length > MAX_LOGS) {
      logs.splice(0, logs.length - MAX_LOGS);
    }
    
    await chrome.storage.local.set({ [STORAGE_KEY]: logs });
  } catch (err) {
    console.error("[Logger] Failed to write to local storage", err);
  }
}

export const logger = {
  info:  (context, msg, details) => appendLog("INFO", context, msg, details),
  warn:  (context, msg, details) => appendLog("WARN", context, msg, details),
  error: (context, msg, details) => appendLog("ERROR", context, msg, details),
  
  /** Retrieves all stored logs */
  getLogs: async () => {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      return data[STORAGE_KEY] || [];
    } catch {
      return [];
    }
  },
  
  /** Clears all stored logs */
  clearLogs: async () => {
    try {
      await chrome.storage.local.remove(STORAGE_KEY);
    } catch (err) {
      console.error("[Logger] Failed to clear logs", err);
    }
  }
};
