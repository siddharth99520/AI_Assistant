/**
 * service-worker.js — Background service worker (Manifest V3).
 *
 * Responsibilities:
 *  - Handles "CALL_OLLAMA" messages from content scripts
 *  - Loads config from chrome.storage.sync
 *  - Calls Ollama API (fetch is available in service workers)
 *  - Parses response and returns { answerIndex, answerLetter }
 *  - Handles toolbar icon click → triggers MCQ analysis on active tab
 */

import { loadConfig }                from "../shared/config.js";
import { askOllama, pingOllama }     from "../shared/ollama-client.js";
import { buildMCQPrompt, parseAnswerIndex, indexToLetter } from "../shared/prompt-builder.js";

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

  if (msg.action === "GET_CONFIG") {
    loadConfig().then(sendResponse);
    return true;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Toolbar icon click → inject analysis into active tab
// ─────────────────────────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    // Make sure content script is injected (handles cases where it wasn't auto-injected)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/content.js"],
    }).catch(() => {}); // Ignore if already injected

    // Tell content script to run the analysis
    await chrome.tabs.sendMessage(tab.id, { action: "ANALYSE_MCQ" });
  } catch (err) {
    console.error("[SW] Failed to trigger analysis:", err);
  }
});

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

console.info("[MCQ AI Assistant] Service worker started.");
