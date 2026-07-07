/**
 * Handles communication with the Google Gemini API.
 */

export async function callGemini(prompt, config) {
  if (!config.geminiApiKey) {
    throw new Error("Gemini API Key is missing. Please configure it in the extension settings.");
  }

  const model = config.geminiModel || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;

  const requestBody = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: config.temperature || 0.1,
      maxOutputTokens: 4096,
    }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.requestTimeoutMs || 30000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorText = "";
      try {
        const errorJson = await response.json();
        errorText = errorJson.error?.message || JSON.stringify(errorJson);
      } catch (e) {
        errorText = await response.text();
      }
      throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.candidates || data.candidates.length === 0) {
      throw new Error("Gemini returned an empty response (no candidates).");
    }

    const text = data.candidates[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("Could not parse text from Gemini response.");
    }

    return text;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${config.requestTimeoutMs}ms.`);
    }
    throw error;
  }
}
