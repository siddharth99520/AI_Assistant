/**
 * options.js — Settings page controller
 */

import { logger } from "../shared/logger.js";

// ── Gemini RPM limits (mirrors config.js) ────────────────────────────────────
const GEMINI_RPM_LIMITS = {
  "gemini-3.5-flash-lite": 30,  // 2 000 ms minimum (fastest, newest)
  "gemini-3.5-flash":      15,  // 4 000 ms minimum
  "gemini-2.5-flash-lite": 30,  // 2 000 ms minimum
  "gemini-2.5-flash":      10,  // 6 000 ms minimum
  "gemini-2.0-flash":      15,  // 4 000 ms minimum
};

function geminiMinDelaySeconds(model) {
  const rpm = GEMINI_RPM_LIMITS[model] ?? 10;
  return Math.ceil(60 / rpm); // returns seconds
}

// ── Shortcut defaults ────────────────────────────────────────────────────────

const DEFAULT_SHORTCUTS = {
  solveMcq:        "Ctrl+Shift+M",   // In-page (also fires via manifest command)
  toggleSidebar:   "Ctrl+Shift+S",   // Chrome command only
  solveCode:       "Ctrl+Shift+K",   // In-page (also fires via manifest command)
  toggleAutoPilot: "Ctrl+Shift+X",   // Chrome command only
  nextQuestion:    "Ctrl+Shift+N",
  reAnalyse:       "Ctrl+Shift+R",
  closeSidebar:    "Escape",
  selectOptionA:   "Alt+A",
  selectOptionB:   "Alt+B",
  selectOptionC:   "Alt+C",
  selectOptionD:   "Alt+D",
  openSettings:    "Ctrl+Shift+P",
  toggleHighlight: "Alt+H",
  toggleStealth:   "Alt+S",
};

// Chrome manifest command keys — read-only (changed via chrome://extensions/shortcuts)
const CHROME_COMMAND_KEYS = ["toggleSidebar", "toggleAutoPilot"];

// In-page shortcut keys — fully customizable from settings
const PAGE_SHORTCUT_KEYS = [
  "solveMcq", "solveCode",
  "nextQuestion", "reAnalyse", "closeSidebar",
  "selectOptionA", "selectOptionB", "selectOptionC", "selectOptionD",
  "openSettings", "toggleHighlight", "toggleStealth",
];

const DEFAULT_CONFIG = {
  aiProvider:              "ollama",           // legacy fallback
  mcqProvider:             "ollama",           // "ollama" | "gemini" — MCQ solving
  codingProvider:          "gemini",           // "ollama" | "gemini" — code solving
  geminiApiKey:            "",                 // Must be listed so chrome.storage.sync.get retrieves it
  geminiModel:             "gemini-3.5-flash-lite", // Must be listed so chrome.storage.sync.get retrieves it
  ollamaBaseUrl:           "http://localhost:11434",
  ollamaModel:             "gemma3-limited",  // Custom model with num_gpu:28 (GTX 1650 fix)
  requestTimeoutMs:        120000,            // 2 min — allows cold-start model load
  temperature:             0.1,
  maxTokens:               50,                 // MCQ answer is a single letter
  highlightCorrectOption:  true,
  highlightColor:          "#22c55e",
  autoCloseFloatingPanel:  true,
  autoClickNext:           false,
  autoClickDelay:          1500,
  rapidFireSpeed:          400,
  primaryStrategy:         "classNameHeuristics",
  shortcuts:               { ...DEFAULT_SHORTCUTS },
};

// ── Element refs ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const fields = {
  mcqProvider:      $("mcq-provider"),
  codingProvider:   $("coding-provider"),
  geminiApiKey:     $("gemini-api-key"),
  geminiModel:      $("gemini-model"),
  ollamaUrl:        $("ollama-url"),
  ollamaModel:      $("ollama-model"),
  reqTimeout:       $("req-timeout"),
  temperature:      $("temperature"),
  maxTokens:        $("max-tokens"),
  highlightToggle:  $("highlight-toggle"),
  highlightColor:   $("highlight-color"),
  highlightHex:     $("highlight-hex"),
  autocloseToggle:  $("autoclose-toggle"),
  autoclickNextToggle: $("autoclick-next-toggle"),
  autoclickDelayInput: $("autoclick-delay-input"),
  rapidFireSpeed:   $("rapid-fire-speed"),
  rapidFireSpeedVal: $("rapid-fire-speed-val"),
  strategySelect:   $("strategy-select"),
};

// Shortcut input refs (keyed by action name)
const shortcutInputs = {};
[...CHROME_COMMAND_KEYS, ...PAGE_SHORTCUT_KEYS].forEach(key => {
  shortcutInputs[key] = $(`sc-${key}`);
});

// ── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  const cfg = await loadConfig();
  populateForm(cfg);
  bindEvents();
  bindShortcutRecording();
  bindLogsViewer();
  testConnection(); // Auto-test to populate model datalist
})();

// ── Load & populate ──────────────────────────────────────────────────────────

async function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_CONFIG, (data) => resolve({ ...DEFAULT_CONFIG, ...data }));
  });
}

function populateForm(cfg) {
  if (!cfg) cfg = DEFAULT_CONFIG;

  if (fields.mcqProvider)    fields.mcqProvider.value    = cfg.mcqProvider    || "ollama";
  if (fields.codingProvider) fields.codingProvider.value = cfg.codingProvider || "gemini";
  if (fields.geminiApiKey) fields.geminiApiKey.value = cfg.geminiApiKey || "";
  if (fields.geminiModel) fields.geminiModel.value = cfg.geminiModel || "gemini-3.5-flash-lite";
  fields.ollamaUrl.value       = cfg.ollamaBaseUrl;
  fields.ollamaModel.value     = cfg.ollamaModel;
  fields.reqTimeout.value      = cfg.requestTimeoutMs;
  fields.temperature.value     = cfg.temperature;
  fields.maxTokens.value       = cfg.maxTokens;
  fields.highlightToggle.checked  = cfg.highlightCorrectOption;
  fields.highlightColor.value  = cfg.highlightColor;
  fields.highlightHex.value    = cfg.highlightColor;
  fields.autocloseToggle.checked  = cfg.autoCloseFloatingPanel;
  if (fields.autoclickNextToggle) fields.autoclickNextToggle.checked = !!cfg.autoClickNext;
  if (fields.autoclickDelayInput) fields.autoclickDelayInput.value = (cfg.autoClickDelay || 1500) / 1000;
  fields.strategySelect.value  = cfg.primaryStrategy || "classNameHeuristics";
  if (fields.rapidFireSpeed) {
    fields.rapidFireSpeed.value = cfg.rapidFireSpeed || 400;
    if (fields.rapidFireSpeedVal) fields.rapidFireSpeedVal.textContent = `${fields.rapidFireSpeed.value}ms`;
  }

  // Populate shortcut inputs
  const shortcuts = { ...DEFAULT_SHORTCUTS, ...(cfg.shortcuts || {}) };
  Object.entries(shortcuts).forEach(([action, combo]) => {
    if (shortcutInputs[action]) {
      shortcutInputs[action].value = combo;
    }
  });

  // Refresh the RPM warning to match the loaded config
  updateRpmWarning();
}

// ── Events ───────────────────────────────────────────────────────────────────

function bindEvents() {
  // Colour picker ↔ hex input sync
  fields.highlightColor.addEventListener("input", () => {
    fields.highlightHex.value = fields.highlightColor.value;
  });
  fields.highlightHex.addEventListener("input", () => {
    if (/^#[0-9a-fA-F]{6}$/.test(fields.highlightHex.value)) {
      fields.highlightColor.value = fields.highlightHex.value;
    }
  });

  // Rapid Fire Speed slider — live label update
  if (fields.rapidFireSpeed && fields.rapidFireSpeedVal) {
    fields.rapidFireSpeed.addEventListener("input", () => {
      fields.rapidFireSpeedVal.textContent = `${fields.rapidFireSpeed.value}ms`;
    });
  }

  // RPM warning: update whenever MCQ provider or Gemini model changes
  if (fields.mcqProvider) fields.mcqProvider.addEventListener("change", updateRpmWarning);
  if (fields.geminiModel)  fields.geminiModel.addEventListener("change",  updateRpmWarning);

  // Connection test
  $("btn-test-conn").addEventListener("click", testConnection);

  // Save
  $("btn-save").addEventListener("click", saveSettings);

  // Reset
  $("btn-reset").addEventListener("click", async () => {
    if (confirm("Reset all settings to defaults?")) {
      await new Promise((res) => chrome.storage.sync.set(DEFAULT_CONFIG, res));
      populateForm(DEFAULT_CONFIG);
      showToast("Settings reset to defaults.", "ok");
    }
  });

  // Shortcut per-row reset buttons
  document.querySelectorAll(".btn-shortcut-reset").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action && DEFAULT_SHORTCUTS[action] && shortcutInputs[action]) {
        shortcutInputs[action].value = DEFAULT_SHORTCUTS[action];
        checkShortcutConflicts();
      }
    });
  });
}

// ── RPM Warning ──────────────────────────────────────────────────────────────

/**
 * Shows or hides the RPM warning under the auto-pilot delay input.
 * Called on page load and whenever the MCQ provider or Gemini model changes.
 */
function updateRpmWarning() {
  const warning   = $("rpm-warning");
  const minValEl  = $("rpm-min-val");
  if (!warning || !minValEl) return;

  const isGemini  = fields.mcqProvider?.value === "gemini";
  if (isGemini) {
    const model   = fields.geminiModel?.value || "gemini-2.5-flash";
    const minSec  = geminiMinDelaySeconds(model);
    minValEl.textContent = minSec;
    warning.classList.add("visible");

    // Also clamp the delay input's min attribute so the browser validates it
    if (fields.autoclickDelayInput) {
      fields.autoclickDelayInput.min = minSec;
    }
  } else {
    warning.classList.remove("visible");
    if (fields.autoclickDelayInput) {
      fields.autoclickDelayInput.min = 0;
    }
  }
}


function bindShortcutRecording() {
  PAGE_SHORTCUT_KEYS.forEach(action => {
    const input = shortcutInputs[action];
    if (!input) return;

    // On focus: show placeholder to indicate recording mode
    input.addEventListener("focus", () => {
      input.dataset.prevValue = input.value;
      input.value = "Press keys…";
      input.style.color = "#f59e0b"; // Amber to indicate recording
    });

    // On keydown: capture the combo
    input.addEventListener("keydown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const combo = eventToCombo(e);
      if (!combo) return; // Only modifier pressed, keep waiting

      input.value = combo;
      input.style.color = ""; // Reset colour
      input.blur(); // Exit recording mode
      checkShortcutConflicts();
    });

    // On blur without recording: restore previous value if still showing placeholder
    input.addEventListener("blur", () => {
      if (input.value === "Press keys…") {
        input.value = input.dataset.prevValue || DEFAULT_SHORTCUTS[action];
      }
      input.style.color = "";
    });
  });
}

/**
 * Convert a KeyboardEvent into a normalised combo string (same logic as content.js).
 */
function eventToCombo(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  const key = e.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null;

  if (key === "Escape") {
    parts.length = 0;
    parts.push("Escape");
  } else {
    parts.push(key.length === 1 ? key.toUpperCase() : key);
  }

  return parts.join("+");
}

/**
 * Check for duplicate keybinding conflicts among in-page shortcuts.
 */
function checkShortcutConflicts() {
  const conflictEl = $("shortcut-conflict");
  if (!conflictEl) return;

  const comboCounts = {};
  PAGE_SHORTCUT_KEYS.forEach(action => {
    const combo = shortcutInputs[action]?.value;
    if (combo && combo !== "Press keys…") {
      if (!comboCounts[combo]) comboCounts[combo] = [];
      comboCounts[combo].push(action);
    }
  });

  const conflicts = Object.entries(comboCounts).filter(([, actions]) => actions.length > 1);
  if (conflicts.length > 0) {
    const msgs = conflicts.map(([combo, actions]) => {
      const names = actions.map(a => a.replace(/([A-Z])/g, " $1").trim()).join(", ");
      return `⚠ "${combo}" is used by: ${names}`;
    });
    conflictEl.textContent = msgs.join(" | ");
    conflictEl.style.display = "block";
  } else {
    conflictEl.style.display = "none";
  }
}

/**
 * Collect current shortcut values from the input fields.
 */
function collectShortcuts() {
  const shortcuts = {};
  [...CHROME_COMMAND_KEYS, ...PAGE_SHORTCUT_KEYS].forEach(action => {
    const val = shortcutInputs[action]?.value;
    if (val && val !== "Press keys…") {
      shortcuts[action] = val;
    } else {
      shortcuts[action] = DEFAULT_SHORTCUTS[action];
    }
  });
  return shortcuts;
}

// ── Connection test ──────────────────────────────────────────────────────────

async function testConnection() {
  const resultEl = $("conn-result");
  resultEl.textContent = "Testing…";
  resultEl.className   = "conn-result";

  const url = fields.ollamaUrl.value.trim() || DEFAULT_CONFIG.ollamaBaseUrl;
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data   = await res.json();
    const modelNames = (data.models || []).map((m) => m.name);
    const models = modelNames.join(", ") || "no models loaded";
    resultEl.textContent = `✓ Connected! Models: ${models}`;
    resultEl.className   = "conn-result ok";

    // Populate datalist
    const dataList = $("ollama-model-list");
    if (dataList) {
      dataList.innerHTML = "";
      modelNames.forEach(name => {
        const option = document.createElement("option");
        option.value = name;
        dataList.appendChild(option);
      });
    }
  } catch (err) {
    resultEl.textContent = `✗ Failed: ${err.message}. Run: ollama serve`;
    resultEl.className   = "conn-result err";
  }
}

// ── Save ─────────────────────────────────────────────────────────────────────

async function saveSettings() {
  const hexValue = fields.highlightHex.value.trim();
  const validHex = /^#[0-9a-fA-F]{6}$/.test(hexValue) ? hexValue : DEFAULT_CONFIG.highlightColor;

  const config = {
    aiProvider:             fields.mcqProvider ? fields.mcqProvider.value : DEFAULT_CONFIG.mcqProvider, // legacy compat
    mcqProvider:            fields.mcqProvider    ? fields.mcqProvider.value    : DEFAULT_CONFIG.mcqProvider,
    codingProvider:         fields.codingProvider ? fields.codingProvider.value : DEFAULT_CONFIG.codingProvider,
    geminiApiKey:           fields.geminiApiKey ? fields.geminiApiKey.value.trim() : "",
    geminiModel:            fields.geminiModel ? fields.geminiModel.value : "gemini-3.5-flash-lite",
    ollamaBaseUrl:          fields.ollamaUrl.value.trim()   || DEFAULT_CONFIG.ollamaBaseUrl,
    ollamaModel:            fields.ollamaModel.value.trim() || DEFAULT_CONFIG.ollamaModel,
    requestTimeoutMs:       Number(fields.reqTimeout.value) || DEFAULT_CONFIG.requestTimeoutMs,
    temperature:            Math.min(1, Math.max(0, Number(fields.temperature.value))),
    maxTokens:              Number(fields.maxTokens.value)  || DEFAULT_CONFIG.maxTokens,
    highlightCorrectOption: fields.highlightToggle.checked,
    highlightColor:         validHex,
    autoCloseFloatingPanel: fields.autocloseToggle.checked,
    autoClickNext:          fields.autoclickNextToggle ? fields.autoclickNextToggle.checked : false,
    autoClickDelay:         fields.autoclickDelayInput ? Math.round(parseFloat(fields.autoclickDelayInput.value) * 1000) : 1500,
    rapidFireSpeed:         fields.rapidFireSpeed ? Number(fields.rapidFireSpeed.value) : 400,
    primaryStrategy:        fields.strategySelect.value,
    shortcuts:              collectShortcuts(),
  };

  try {
    await new Promise((resolve, reject) => {
      chrome.storage.sync.set(config, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
    showToast("✓ Settings saved successfully!", "ok");
  } catch (err) {
    showToast(`✗ Save failed: ${err.message}`, "err");
  }
}

// ── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg, type) {
  const toast = $("save-toast");
  toast.textContent  = msg;
  toast.className    = type;
  toast.style.display = "block";
  setTimeout(() => { toast.style.display = "none"; }, 3500);
}

// ── Logs Viewer ──────────────────────────────────────────────────────────────

function bindLogsViewer() {
  const btnViewLogs = $("btn-view-logs");
  const modalOverlay = $("logs-modal-overlay");
  const btnCloseLogs = $("btn-close-logs");
  const btnClearLogs = $("btn-clear-logs");
  const logsBody = $("logs-body");

  if (!btnViewLogs || !modalOverlay) return;

  btnViewLogs.addEventListener("click", async () => {
    modalOverlay.classList.add("visible");
    await renderLogs(logsBody);
  });

  btnCloseLogs.addEventListener("click", () => {
    modalOverlay.classList.remove("visible");
  });

  // Close when clicking outside the modal
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) {
      modalOverlay.classList.remove("visible");
    }
  });

  btnClearLogs.addEventListener("click", async () => {
    if (confirm("Are you sure you want to clear all logs?")) {
      await logger.clearLogs();
      logsBody.innerHTML = '<div style="color: #64748b; text-align: center; padding: 20px;">Logs cleared.</div>';
    }
  });
}

async function renderLogs(container) {
  container.innerHTML = "Loading...";
  const logs = await logger.getLogs();

  if (!logs || logs.length === 0) {
    container.innerHTML = '<div style="color: #64748b; text-align: center; padding: 20px;">No logs available yet.</div>';
    return;
  }

  // Render in reverse chronological order (newest first)
  const html = logs.reverse().map(log => {
    const time = new Date(log.timestamp).toLocaleTimeString();
    let detailsHtml = "";
    if (log.details) {
      const detailsStr = typeof log.details === 'object' ? JSON.stringify(log.details, null, 2) : log.details;
      detailsHtml = `<span class="log-details">${detailsStr}</span>`;
    }

    return `
      <div class="log-entry">
        <span class="log-time">[${time}]</span>
        <span class="log-level-${log.level}">${log.level}</span>
        <span class="log-ctx">[${log.context}]</span>
        <span class="log-msg">${log.message}</span>
        ${detailsHtml}
      </div>
    `;
  }).join("");

  container.innerHTML = html;
}

