/**
 * config.js — Central configuration & default settings
 * All Ollama-related options live here so they're easy to override.
 * mcqProvider / codingProvider allow per-task AI backend selection.
 */

/**
 * Gemini free-tier RPM limits (Requests Per Minute).
 * Used to compute the minimum safe auto-pilot delay when mcqProvider = "gemini".
 *   delay_min = 60_000ms / RPM  →  one request per RPM window
 */
export const GEMINI_RPM_LIMITS = {
  "gemini-3.5-flash-lite": 30,  // 30 RPM  → 2 000 ms minimum (fastest, newest)
  "gemini-3.5-flash":     15,  // 15 RPM  → 4 000 ms minimum
  "gemini-2.5-flash-lite": 30,  // 30 RPM  → 2 000 ms minimum
  "gemini-2.5-flash":     10,  // 10 RPM  → 6 000 ms minimum
  "gemini-2.0-flash":     15,  // 15 RPM  → 4 000 ms minimum
};

/** Returns the minimum safe delay (ms) for a given Gemini model. */
export function geminiMinDelay(modelName) {
  const rpm = GEMINI_RPM_LIMITS[modelName] ?? 10; // default to strictest if unknown
  return Math.ceil(60_000 / rpm);
}

export const DEFAULT_CONFIG = {
  // AI Settings
  aiProvider:              "ollama", // legacy fallback — use mcqProvider / codingProvider instead
  mcqProvider:             "ollama", // "ollama" | "gemini" — provider used for MCQ solving
  codingProvider:          "gemini", // "ollama" | "gemini" — provider used for code solving
  geminiApiKey:            "",
  geminiModel:             "gemini-2.5-flash-lite", // 30 RPM limit allows fast 2s delay
  ollamaBaseUrl:           "http://localhost:11434",
  ollamaModel:             "gemma3-limited",  // Custom model with num_gpu:28 baked in (GTX 1650 VRAM fix)
  requestTimeoutMs: 120_000,  // 2 min — allows cold-start model load on first request
  temperature: 0.1,          // Low temp → deterministic, factual answers
  maxTokens: 50,          // MCQ answer is a single letter — 512 was wasteful VRAM


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
  autoClickNext: false,
  autoClickDelay: 1500,
  highlightCorrectOption: true,
  highlightColor: "#22c55e",   // Tailwind green-500
  errorColor: "#ef4444",

  // Keyboard Shortcuts
  // First 4 are Chrome manifest commands (fullscreen-safe, change via chrome://extensions/shortcuts)
  // Remaining are in-page shortcuts (fully customizable from settings)
  shortcuts: {
    solveMcq:        "Ctrl+Shift+A",   // Chrome command (manifest)
    toggleSidebar:   "Ctrl+Shift+S",   // Chrome command (manifest)
    solveCode:       "Ctrl+Shift+C",   // Chrome command (manifest)
    toggleAutoPilot: "Ctrl+Shift+X",   // Chrome command (manifest)
    nextQuestion:    "Ctrl+Shift+N",   // In-page
    reAnalyse:       "Ctrl+Shift+R",   // In-page
    closeSidebar:    "Escape",         // In-page
    selectOptionA:   "Alt+A",          // In-page
    selectOptionB:   "Alt+B",          // In-page
    selectOptionC:   "Alt+C",          // In-page
    selectOptionD:   "Alt+D",          // In-page
    openSettings:    "Ctrl+Shift+P",   // In-page
    toggleHighlight: "Alt+H",          // In-page
  },
};

/**
 * Loads persisted config from chrome.storage.sync,
 * merging with defaults so new keys always have values.
 */
export async function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_CONFIG, (stored) => {
      const merged = { ...DEFAULT_CONFIG, ...stored };
      // Guard: enforce minimum 30s timeout.
      // Old stored values (5000/10000ms) cause "context canceled" on Ollama.
      if (merged.requestTimeoutMs < 30_000) {
        merged.requestTimeoutMs = DEFAULT_CONFIG.requestTimeoutMs;
      }
      // Guard: when MCQ is routed through Gemini and Auto-Pilot is on,
      // enforce the free-tier RPM minimum so we don't get 429 errors.
      // minDelay = 60 000ms / RPM, e.g. 6 000ms for gemini-2.5-flash (10 RPM).
      if (merged.mcqProvider === "gemini" && merged.autoClickNext) {
        const minDelay = geminiMinDelay(merged.geminiModel);
        if (merged.autoClickDelay < minDelay) {
          merged.autoClickDelay = minDelay;
        }
      }
      resolve(merged);
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
