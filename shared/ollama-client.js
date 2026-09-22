/**
 * ollama-client.js — Thin API client for the local Ollama server.
 * Handles request construction, timeout, and error normalisation.
 */

import { logger } from "./logger.js";

/**
 * Sends a prompt to Ollama and returns the model's text response.
 *
 * @param {string} prompt        - Full prompt string
 * @param {object} cfg           - Loaded config (ollamaBaseUrl, ollamaModel, …)
 * @returns {Promise<string>}    - Raw text content from the model
 */
export async function askOllama(prompt, cfg) {
  const url = `${cfg.ollamaBaseUrl}/api/generate`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.ollamaModel,
        prompt,
        stream: false,
        options: {
          temperature: cfg.temperature,
          num_predict: cfg.maxTokens,
          num_gpu: 28,   // Offload 28/35 layers to GPU; rest stay in RAM (GTX 1650 4GB fix)
          num_ctx: 512,  // Reduced context: MCQ prompts are ~100 tokens; saves ~1GB KV cache VRAM
        },
      }),
    });

    if (!response.ok) {
      // 403 = Ollama CORS block. Chrome extension origins are blocked by default.
      // Fix: set OLLAMA_ORIGINS=* before starting ollama serve.
      if (response.status === 403) {
        throw new OllamaError(
          "403 Forbidden: Ollama is blocking this extension.\n" +
          "Fix: stop Ollama, then run:\n" +
          "  $env:OLLAMA_ORIGINS='*'; ollama serve",
          403
        );
      }
      const errText = await response.text().catch(() => response.statusText);
      throw new OllamaError(`HTTP ${response.status}: ${errText}`, response.status);
    }

    const data = await response.json();

    if (!data?.response) {
      throw new OllamaError("Ollama returned an empty response object.");
    }

    return data.response.trim();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new OllamaError(
        `Request timed out after ${cfg.requestTimeoutMs / 1000}s. Is Ollama running?`
      );
    }
    if (err instanceof OllamaError) throw err;
    throw new OllamaError(`Network error: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks whether the Ollama server is reachable and the model is loaded.
 * @param {object} cfg
 * @returns {Promise<{ok: boolean, models: string[]}>}
 */
export async function pingOllama(cfg) {
  try {
    const res = await fetch(`${cfg.ollamaBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, models: [] };
    const data = await res.json();
    const models = (data.models ?? []).map((m) => m.name);
    return { ok: true, models };
  } catch {
    return { ok: false, models: [] };
  }
}

// ---------------------------------------------------------------------------
// Custom error class
// ---------------------------------------------------------------------------
export class OllamaError extends Error {
  constructor(message, statusCode = null) {
    super(message);
    this.name = "OllamaError";
    this.statusCode = statusCode;
  }
}
