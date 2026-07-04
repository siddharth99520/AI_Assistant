/**
 * popup.js — Popup UI controller
 */

const $ = (id) => document.getElementById(id);

const btnAnalyse = $("btn-analyse");
const btnRefresh = $("btn-refresh");
const btnOptions = $("btn-options");
const statusDot  = $("status-dot");
const statusText = $("status-text");
const resultToast = $("result-toast");
const footerModel = $("footer-model");
const footerUrl   = $("footer-url");

// ── Init ────────────────────────────────────────────────────────────────────

(async () => {
  await loadDisplayConfig();
  await checkOllamaStatus();
})();

// ── Events ──────────────────────────────────────────────────────────────────

btnAnalyse.addEventListener("click", runAnalysis);
btnRefresh.addEventListener("click", checkOllamaStatus);
btnOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

// ── Ollama Status ────────────────────────────────────────────────────────────

async function checkOllamaStatus() {
  statusDot.className  = "status-dot";
  statusText.textContent = "Checking…";
  btnAnalyse.disabled  = true;

  try {
    const result = await chrome.runtime.sendMessage({ action: "PING_OLLAMA" });
    if (result?.ok) {
      statusDot.classList.add("online");
      statusText.textContent = "Online ✓";
      btnAnalyse.disabled = false;
    } else {
      statusDot.classList.add("offline");
      statusText.textContent = "Offline";
      showToast("Ollama not reachable. Start it with: ollama serve", true);
    }
  } catch {
    statusDot.classList.add("offline");
    statusText.textContent = "Error";
  }
}

// ── Load Config Display ──────────────────────────────────────────────────────

async function loadDisplayConfig() {
  try {
    const cfg = await chrome.runtime.sendMessage({ action: "GET_CONFIG" });
    footerModel.textContent = `Model: ${cfg.ollamaModel}`;
    footerUrl.textContent   = cfg.ollamaBaseUrl.replace("http://", "");
  } catch {
    footerModel.textContent = "Model: unknown";
  }
}

// ── Analysis ─────────────────────────────────────────────────────────────────

async function runAnalysis() {
  setLoading(true);
  hideToast();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab found.");

    // Only inject content script if it isn't already running
    let alive = false;
    try {
      const ping = await chrome.tabs.sendMessage(tab.id, { action: "PING" });
      alive = ping?.alive === true;
    } catch { /* not injected yet */ }

    if (!alive) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/content.js"],
      }).catch(() => {});
      // Small delay to let the script initialise
      await new Promise(r => setTimeout(r, 150));
    }

    const response = await chrome.tabs.sendMessage(tab.id, { action: "ANALYSE_MCQ" });

    if (response?.success) {
      showToast(`✓ Answer selected: Option ${response.answerLetter}`, false);
    } else {
      showToast(response?.error || "Analysis failed.", true);
    }
  } catch (err) {
    showToast(err.message || "Unexpected error.", true);
  } finally {
    setLoading(false);
  }
}

// ── UI Helpers ───────────────────────────────────────────────────────────────

function setLoading(on) {
  btnAnalyse.classList.toggle("loading", on);
  btnAnalyse.disabled = on;
}

function showToast(msg, isError = false) {
  resultToast.textContent = msg;
  resultToast.className   = isError ? "error" : "";
  resultToast.style.display = "block";
}

function hideToast() {
  resultToast.style.display = "none";
}
