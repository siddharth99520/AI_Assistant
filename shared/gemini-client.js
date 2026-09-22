/**
 * gemini-client.js — Handles communication with the Google Gemini API.
 *
 * Features:
 *  - Automatic retry with backoff on 429 (quota exceeded).
 *    Reads the `retryDelay` seconds from the error body when available,
 *    otherwise uses exponential backoff: 6 s → 12 s → 24 s (3 attempts).
 *  - Clear error messages for every non-2xx status code.
 */

import { logger } from "./logger.js";

const MAX_RETRIES    = 3;
const BASE_DELAY_MS  = 6_000; // 6 s — matches gemini-2.5-flash 10 RPM minimum

/** Simple promise-based sleep. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Extracts the retry-after delay (ms) from a Gemini 429 error body.
 * The API returns something like: { error: { details: [{ retryDelay: "21s" }] } }
 */
function parseRetryDelay(errorJson) {
  try {
    const details = errorJson?.error?.details ?? [];
    for (const d of details) {
      // retryDelay is a string like "21.640s" or "21s"
      if (d.retryDelay) {
        const seconds = parseFloat(d.retryDelay);
        if (!isNaN(seconds)) return Math.ceil(seconds * 1000);
      }
      // Some responses use "@type": "RetryInfo" with retryDelay inside
      if (d["@type"]?.includes("RetryInfo") && d.retryDelay) {
        const seconds = parseFloat(d.retryDelay);
        if (!isNaN(seconds)) return Math.ceil(seconds * 1000);
      }
    }
  } catch (_) { /* ignore parse errors */ }
  return null;
}

/**
 * Calls the Gemini generateContent API with automatic 429 retry.
 *
 * @param {string} prompt     - The full prompt text
 * @param {object} config     - Loaded extension config (geminiApiKey, geminiModel, …)
 * @param {function} [onRetry] - Optional callback(attemptNumber, waitMs) for UI feedback
 * @returns {Promise<string>} - Raw text from the first candidate
 */
export async function callGemini(prompt, config, onRetry = null) {
  if (!config.geminiApiKey) {
    throw new Error("Gemini API Key is missing. Please configure it in the extension settings.");
  }

  const model = config.geminiModel || "gemini-2.5-flash-lite";
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature:      config.temperature    || 0.1,
      maxOutputTokens:  8192, // Hardcoded to 8192 to prevent long code from being cut off
    },
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), config.requestTimeoutMs || 30_000);

    try {
      const response = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(requestBody),
        signal:  controller.signal,
      });

      clearTimeout(timeoutId);

      // ── 429 Rate-limit: retry with backoff ───────────────────────────────
      if (response.status === 429) {
        let errorJson = null;
        try { errorJson = await response.json(); } catch (_) {}

        // Prefer the server-provided retryDelay; fall back to exponential backoff
        const waitMs = parseRetryDelay(errorJson) ?? (BASE_DELAY_MS * (2 ** (attempt - 1)));

        logger.warn("Gemini Client", `429 on attempt ${attempt}/${MAX_RETRIES}. Waiting ${waitMs}ms before retry…`, errorJson);
        if (onRetry) onRetry(attempt, waitMs);

        if (attempt === MAX_RETRIES) {
          const waitSec = (waitMs / 1000).toFixed(0);
          throw new Error(
            `Gemini rate limit (429): quota exceeded for ${model}. ` +
            `Tried ${MAX_RETRIES}× — last retry-after was ${waitSec}s. ` +
            `Switch MCQ provider to Ollama in Settings to avoid this.`
          );
        }

        await sleep(waitMs);
        continue; // next attempt
      }

      // ── Other non-2xx errors ─────────────────────────────────────────────
      if (!response.ok) {
        let errorText = "";
        try {
          const errorJson = await response.json();
          errorText = errorJson.error?.message || JSON.stringify(errorJson);
        } catch (_) {
          errorText = await response.text();
        }
        throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
      }

      // ── Success ──────────────────────────────────────────────────────────
      const data = await response.json();

      if (!data.candidates || data.candidates.length === 0) {
        throw new Error("Gemini returned an empty response (no candidates).");
      }

      const text = data.candidates[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Could not parse text from Gemini response.");

      return text;

    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === "AbortError") {
        throw new Error(`Gemini request timed out after ${config.requestTimeoutMs}ms.`);
      }
      // Re-throw non-retryable errors immediately
      throw error;
    }
  }

  // Should never reach here
  throw new Error("Gemini: exceeded maximum retries.");
}
