/**
 * config.js — Central configuration & default settings
 * All Ollama-related options live here so they're easy to override.
 */

export const DEFAULT_CONFIG = {
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "deepseek-coder:6.7b",
  requestTimeoutMs: 30_000,
  temperature: 0.1,          // Low temp → deterministic, factual answers
  maxTokens: 512,

  // DOM extraction strategy priority order
  // The extractor tries each strategy until one succeeds
  extractionStrategies: [
    "dataAttributes",        // data-question, data-option attributes
    "ariaLabels",            // aria-label, role="radio" / role="checkbox"
    "semanticHTML",          // <fieldset>, <legend>, <label> + <input>
    "classNameHeuristics",   // common class patterns (e.g. .question, .option)
    "genericHeuristics",     // fallback: longest <p> + nearby list items
  ],

  // UI
  autoCloseFloatingPanel: true,
  highlightCorrectOption: true,
  highlightColor: "#22c55e",   // Tailwind green-500
  errorColor: "#ef4444",
};

/**
 * Loads persisted config from chrome.storage.sync,
 * merging with defaults so new keys always have values.
 */
export async function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_CONFIG, (stored) => {
      resolve({ ...DEFAULT_CONFIG, ...stored });
    });
  });
}

/**
 * Persists a partial config update.
 * @param {Partial<typeof DEFAULT_CONFIG>} updates
 */
export async function saveConfig(updates) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(updates, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}
