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
 * Builds a strict, deterministic prompt for the local Ollama model (gemma3-limited).
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
 * @param {string} problemDescription - The full problem text
 * @param {string} [language="Java"]  - Programming language to solve in
 * @returns {string}
 */
export function buildCodingPrompt(problemDescription, language = "Java") {
  const langNote = _getLangInstructions(language);
  return `You are an expert ${language} programmer.
Solve the following coding problem.

CRITICAL INSTRUCTIONS:
1. Provide ONLY the raw ${language} code.
2. Do NOT wrap the code in markdown blocks (e.g. \`\`\`${language.toLowerCase()}).
3. Do NOT provide any explanations, boilerplate text outside the code, or markdown formatting.
4. Do NOT include any comments (like // or /* */) inside the code.
${langNote}

PROBLEM STATEMENT:
${problemDescription}`;
}

/**
 * Returns language-specific coding instructions for the prompt.
 * @param {string} language
 * @returns {string}
 */
function _getLangInstructions(language) {
  switch (language.toLowerCase()) {
    case "java":
      return '5. Use class name "Main" with public static void main(String[] args). Include all needed imports.';
    case "python":
    case "python 3":
    case "python3":
      return '5. Write clean Python. No class wrapper unless the problem requires it. Use if __name__ == "__main__" only if needed.';
    case "c++":
    case "cpp":
      return '5. Include all necessary headers (e.g. #include <iostream>). Use int main() as the entry point.';
    case "c":
      return '5. Include all necessary headers (e.g. #include <stdio.h>). Use int main() as the entry point.';
    case "mysql":
    case "sql":
      return '5. Write a clean SQL/MySQL query. No surrounding code or boilerplate — just the query.';
    case "javascript":
    case "js":
      return '5. Write the function directly. No class wrapper unless specified by the problem.';
    case "typescript":
    case "ts":
      return '5. Write typed TypeScript. Include type annotations. Export the function if the problem requires it.';
    case "c#":
    case "csharp":
      return '5. Use class Solution with a static Main method or the method specified by the problem.';
    case "go":
    case "golang":
      return '5. Include package main. Use func main() as entry point. Add all necessary imports.';
    case "kotlin":
      return '5. Use fun main() as entry point. Include all necessary imports.';
    case "ruby":
      return '5. Write clean Ruby. No class wrapper unless the problem requires it.';
    case "php":
      return '5. Start with <?php. Write clean PHP without HTML.';
    case "swift":
      return '5. Write clean Swift. Include necessary imports.';
    case "rust":
      return '5. Include fn main(). Add all necessary use statements.';
    case "scala":
      return '5. Use object Main with def main(args: Array[String]): Unit as entry point.';
    case "r":
      return '5. Write clean R code. No boilerplate needed.';
    default:
      return `5. Follow standard ${language} conventions.`;
  }
}
