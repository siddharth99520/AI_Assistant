/**
 * service-worker.js — Background service worker (Manifest V3).
 *
 * Responsibilities:
 *  - Handles "CALL_OLLAMA" messages from content scripts
 *  - Loads config from chrome.storage.sync
 *  - Calls Ollama API (fetch is available in service workers)
 *  - Parses response and returns { answerIndex, answerLetter }
 *  - Handles toolbar icon click → opens sidebar on active tab
 *  - Handles keyboard shortcuts (Ctrl+Shift+A and Ctrl+Shift+S)
 *    — these work even in strict fullscreen mode
 */

import { loadConfig }                from "../shared/config.js";
import { askOllama, pingOllama }     from "../shared/ollama-client.js";
import { callGemini }                from "../shared/gemini-client.js";
import { buildMCQPrompt, parseAnswerIndex, indexToLetter, buildCodingPrompt } from "../shared/prompt-builder.js";

// ─────────────────────────────────────────────────────────────────────────────
// Message Router
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "CALL_OLLAMA") {
    handleCallOllama(msg.payload, sendResponse);
    return true; // async
  }

  if (msg.action === "PING_OLLAMA") {
    handlePingOllama(sendResponse);
    return true;
  }

  if (msg.action === "CALL_GEMINI_CODE") {
    handleCallGeminiCode(msg.payload, sendResponse);
    return true;
  }

  if (msg.action === "GET_CONFIG") {
    loadConfig().then(sendResponse);
    return true;
  }
});

async function handleCallGeminiCode(payload, sendResponse) {
  try {
    const cfg = await loadConfig();
    const { problemText } = payload;
    
    console.log("[SW] Building Coding Prompt for problem length:", problemText.length);
    const prompt = buildCodingPrompt(problemText);
    
    console.log("[SW] Calling Gemini API...");
    const rawCode = await callGemini(prompt, cfg);
    
    console.log("[SW] Gemini returned code of length:", rawCode.length);
    
    sendResponse({ ok: true, code: rawCode });
  } catch (err) {
    console.error("[SW] handleCallGeminiCode Error:", err);
    sendResponse({ ok: false, error: err.message || String(err) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Toolbar icon click → toggle sidebar (popup is removed; icon click = sidebar)
// ─────────────────────────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await _ensureContentScript(tab.id);
  chrome.tabs.sendMessage(tab.id, { action: "TOGGLE_SIDEBAR" }).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard Shortcuts (work in fullscreen — Chrome routes them even in fullscreen)
//   Ctrl+Shift+A  →  Analyse current MCQ  (defined as "analyse-mcq" in manifest)
//   Ctrl+Shift+S  →  Toggle sidebar       (defined as "toggle-sidebar" in manifest)
// ─────────────────────────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  await _ensureContentScript(tab.id);

  if (command === "analyse-mcq") {
    console.info("[SW] Keyboard shortcut: analyse-mcq");
    chrome.tabs.sendMessage(tab.id, { action: "ANALYSE_MCQ" }).catch(() => {});
  }

  if (command === "toggle-sidebar") {
    console.info("[SW] Keyboard shortcut: toggle-sidebar");
    chrome.tabs.sendMessage(tab.id, { action: "TOGGLE_SIDEBAR" }).catch(() => {});
  }
});

/**
 * Ensures the content script is injected into the given tab.
 * Safe to call multiple times — Chrome silently ignores re-injection errors.
 */
async function _ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/content.js"],
  }).catch(() => {}); // Already injected → ignore
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleCallOllama(mcq, sendResponse) {
  try {
    const cfg    = await loadConfig();
    const prompt = buildMCQPrompt(mcq);

    console.info("[SW] Sending prompt to Ollama:\n", prompt);

    const rawResponse = await askOllama(prompt, cfg);
    console.info("[SW] Ollama raw response:", rawResponse);

    const answerIndex  = parseAnswerIndex(rawResponse, mcq.options.length);
    const answerLetter = answerIndex !== null ? indexToLetter(answerIndex) : "?";

    if (answerIndex === null) {
      sendResponse({
        success: false,
        error: `Model returned unparseable response: "${rawResponse}". Expected a single letter (A, B, C…).`,
      });
      return;
    }

    sendResponse({ success: true, answerIndex, answerLetter, rawResponse, cfg });
  } catch (err) {
    console.error("[SW] handleCallOllama error:", err);
    sendResponse({ success: false, error: err.message || "Unknown error in service worker." });
  }
}

async function handlePingOllama(sendResponse) {
  try {
    const cfg    = await loadConfig();
    const result = await pingOllama(cfg);
    sendResponse(result);
  } catch (err) {
    sendResponse({ ok: false, models: [], error: err.message });
  }
}

console.info("[MCQ AI Assistant v2] Service worker started. Keyboard shortcuts: Ctrl+Shift+A (analyse), Ctrl+Shift+S (sidebar).");
