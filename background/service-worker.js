/**
 * service-worker.js — Background service worker (Manifest V3).
 *
 * Responsibilities:
 *  - Handles "CALL_OLLAMA" messages from content scripts (provider-agnostic)
 *  - Routes MCQ solving to Gemini or Ollama based on cfg.aiProvider
 *  - Loads config from chrome.storage.sync
 *  - Parses response and returns { answerIndex, answerLetter }
 *  - Handles toolbar icon click → opens sidebar on active tab
 *  - Handles keyboard shortcuts (Ctrl+Shift+A and Ctrl+Shift+S)
 *    — these work even in strict fullscreen mode
 */

import { loadConfig }                from "../shared/config.js";
import { askOllama, pingOllama }     from "../shared/ollama-client.js";
import { callGemini }                from "../shared/gemini-client.js";
import { buildMCQPrompt, parseAnswerIndex, indexToLetter, buildCodingPrompt } from "../shared/prompt-builder.js";
import { logger }                    from "../shared/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Message Router
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "CALL_OLLAMA" || msg.action === "SOLVE_MCQ") {
    handleSolveMCQ(msg.payload, sendResponse);
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

  if (msg.action === "OPEN_OPTIONS_PAGE") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }

  if (msg.action === "LOG") {
    const { level, context, message, details } = msg;
    if (level === "ERROR") {
      logger.error(context, message, details);
    } else if (level === "WARN") {
      logger.warn(context, message, details);
    } else {
      logger.info(context, message, details);
    }
    // sendResponse is not strictly needed for fire-and-forget logging
  }
});

async function handleCallGeminiCode(payload, sendResponse) {
  try {
    const cfg = await loadConfig();
    const { problemText, language = "Java", tabId } = payload;
    const provider = cfg.codingProvider || cfg.aiProvider || "gemini";

    logger.info("SW", `Building Coding Prompt | Provider: ${provider} | Language: ${language} | Problem length: ${problemText.length}`);
    const prompt = buildCodingPrompt(problemText, language);

    let rawCode;
    if (provider === "ollama") {
      logger.info("SW", "Calling Ollama for coding...");
      rawCode = await askOllama(prompt, cfg);
    } else {
      if (!cfg.geminiApiKey) {
        sendResponse({ ok: false, error: "Gemini API key is not set. Go to Settings and add your key." });
        return;
      }
      logger.info("SW", "Calling Gemini API for coding...");
      rawCode = await callGemini(prompt, cfg, (attempt, waitMs) => {
        const waitSec = Math.ceil(waitMs / 1000);
        logger.warn("SW", `Gemini coding 429 — retry ${attempt} in ${waitSec}s`);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            action: "GEMINI_RETRY",
            attempt, waitSec, context: "coding",
          }).catch(() => {});
        }
      });
    }

    logger.info("SW", "Coding provider returned code of length:", rawCode.length);
    sendResponse({ ok: true, code: rawCode, language });
  } catch (err) {
    logger.error("SW", "handleCallGeminiCode Error:", err);
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
    logger.info("SW", "Keyboard shortcut: analyse-mcq");
    chrome.tabs.sendMessage(tab.id, { action: "ANALYSE_MCQ" }).catch(() => {});
  }

  if (command === "toggle-sidebar") {
    logger.info("SW", "Keyboard shortcut: toggle-sidebar");
    chrome.tabs.sendMessage(tab.id, { action: "TOGGLE_SIDEBAR" }).catch(() => {});
  }

  if (command === "solve-code") {
    logger.info("SW", "Keyboard shortcut: solve-code");
    chrome.tabs.sendMessage(tab.id, { action: "SOLVE_CODE" }).catch(() => {});
  }

  if (command === "toggle-autopilot") {
    logger.info("SW", "Keyboard shortcut: toggle-autopilot");
    chrome.tabs.sendMessage(tab.id, { action: "TOGGLE_AUTOPILOT" }).catch(() => {});
  }

  if (command === "rapid-fire") {
    logger.info("SW", "Keyboard shortcut: rapid-fire");
    chrome.tabs.sendMessage(tab.id, { action: "TOGGLE_RAPID_FIRE" }).catch(() => {});
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

/**
 * Routes MCQ solving to Gemini or Ollama based on cfg.aiProvider.
 */
async function handleSolveMCQ(mcq, sendResponse) {
  try {
    const cfg    = await loadConfig();
    const prompt = buildMCQPrompt(mcq);
    const provider = cfg.mcqProvider || cfg.aiProvider || "ollama";

    let rawResponse;

    if (provider === "gemini") {
      if (!cfg.geminiApiKey) {
        sendResponse({
          success: false,
          error: "Gemini API key is not set. Go to Settings and add your key, or switch provider to Ollama.",
        });
        return;
      }
      logger.info("SW", "Routing MCQ to Gemini...");
      rawResponse = await callGemini(prompt, cfg, async (attempt, waitMs) => {
        const waitSec = Math.ceil(waitMs / 1000);
        logger.warn("SW", `Gemini MCQ 429 — retry ${attempt}/${3} in ${waitSec}s`);
        // Notify the active tab so the sidebar can show a countdown
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, {
            action: "GEMINI_RETRY",
            attempt, waitSec, context: "mcq",
          }).catch(() => {});
        }
      });
      logger.info("SW", "Gemini raw response:", rawResponse);
    } else {
      logger.info("SW", "Routing MCQ to Ollama...");
      rawResponse = await askOllama(prompt, cfg);
      logger.info("SW", "Ollama raw response:", rawResponse);
    }

    const answerIndex  = parseAnswerIndex(rawResponse, mcq.options.length, mcq.options);
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
    logger.error("SW", "handleSolveMCQ error:", err);
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

logger.info("SW", "[MCQ AI Assistant v2] Service worker started. Keyboard shortcuts: Ctrl+Shift+A (analyse), Ctrl+Shift+S (sidebar), Ctrl+Shift+C (solve code), Ctrl+Shift+X (toggle autopilot).");
