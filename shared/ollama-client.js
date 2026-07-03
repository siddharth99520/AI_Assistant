/**
 * ollama-client.js — Thin API client for the local Ollama server.
 * Handles request construction, timeout, and error normalisation.
 */

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
        },
      }),
    });

    if (!response.ok) {
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
