/**
 * prompt-builder.js — Constructs the LLM prompt from an extracted MCQ object.
 *
 * Keeping prompt logic separate makes it easy to iterate on phrasing
 * without touching extraction or selection code.
 */

/**
 * @typedef {Object} MCQData
 * @property {string}   question     - The question text
 * @property {string[]} options      - Array of option texts
 * @property {string}   [context]    - Optional surrounding paragraph / topic hint
 */

/**
 * Builds a strict, deterministic prompt for DeepSeek.
 * The model is instructed to reply with ONLY the option letter (A, B, C, …).
 *
 * @param {MCQData} mcq
 * @returns {string}
 */
export function buildMCQPrompt(mcq) {
  const optionLines = mcq.options
    .map((opt, idx) => `${indexToLetter(idx)}. ${opt.trim()}`)
    .join("\n");

  const contextBlock = mcq.context
    ? `Context / Topic:\n${mcq.context.trim()}\n\n`
    : "";

  return `You are an expert exam assistant. Answer the following multiple-choice question accurately.

${contextBlock}Question:
${mcq.question.trim()}

Options:
${optionLines}

Instructions:
- Read all options carefully.
- Choose the single best answer.
- Reply with ONLY the option letter (e.g. A, B, C, or D). No explanation, no punctuation, nothing else.

Answer:`;
}

/**
 * Parses the raw LLM output and maps it back to a zero-based option index.
 *
 * @param {string} rawResponse   - e.g. "B", "b.", "  C  "
 * @param {number} totalOptions  - Number of available options
 * @returns {number|null}        - Zero-based index, or null if unparseable
 */
export function parseAnswerIndex(rawResponse, totalOptions) {
  if (!rawResponse) return null;

  // Extract first alphabetic character
  const match = rawResponse.trim().match(/^([A-Za-z])/);
  if (!match) return null;

  const idx = match[1].toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
  return idx >= 0 && idx < totalOptions ? idx : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 0 → "A", 1 → "B", … */
export function indexToLetter(idx) {
  return String.fromCharCode("A".charCodeAt(0) + idx);
}

/**
 * Builds the prompt for a coding problem to be sent to Gemini.
 */
export function buildCodingPrompt(problemDescription) {
  return `You are an expert Java programmer. 
Solve the following coding problem.

CRITICAL INSTRUCTIONS:
1. Provide ONLY the raw Java code. 
2. Do NOT wrap the code in markdown blocks (e.g. \`\`\`java). 
3. Do NOT provide any explanations, boilerplate text outside the code, or markdown formatting.
4. Do NOT include any comments (like // or /* */) inside the code. 
5. If there is a specific class name required (like "Main" or "Solution"), ensure it is used, otherwise use "Main".

PROBLEM STATEMENT:
${problemDescription}`;
}
