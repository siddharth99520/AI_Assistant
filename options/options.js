/**
 * options.js — Settings page controller
 */

const DEFAULT_CONFIG = {
  ollamaBaseUrl:           "http://localhost:11434",
  ollamaModel:             "gemma3:4b",
  requestTimeoutMs:        30000,
  temperature:             0.1,
  maxTokens:               512,
  highlightCorrectOption:  true,
  highlightColor:          "#22c55e",
  autoCloseFloatingPanel:  true,
  autoClickNext:           false,
  autoClickDelay:          1500,
  primaryStrategy:         "classNameHeuristics",
};

// ── Element refs ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const fields = {
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
  strategySelect:   $("strategy-select"),
};

// ── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  const cfg = await loadConfig();
  populateForm(cfg);
  bindEvents();
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

  if (fields.geminiApiKey) fields.geminiApiKey.value = cfg.geminiApiKey || "";
  if (fields.geminiModel) fields.geminiModel.value = cfg.geminiModel || "gemini-2.5-flash";
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
    geminiApiKey:           fields.geminiApiKey ? fields.geminiApiKey.value.trim() : "",
    geminiModel:            fields.geminiModel ? fields.geminiModel.value : "gemini-2.5-flash",
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
    primaryStrategy:        fields.strategySelect.value,
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
