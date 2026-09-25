/**
 * dom-extractor.js — Multi-strategy MCQ extractor for arbitrary quiz portals.
 *
 * Strategy priority (configured via config.extractionStrategies):
 *  1. dataAttributes      — data-question / data-option* attributes
 *  2. ariaLabels          — ARIA roles (role="radio/checkbox") + fieldset/legend
 *  3. semanticHTML        — <fieldset> + <legend> + <label>/<input> combos
 *  4. classNameHeuristics — Common class names (.question, .option, .choice, …)
 *  5. genericHeuristics   — Longest <p> sibling + nearby list items (last resort)
 *
 * Each strategy returns null if it cannot find a valid MCQ,
 * allowing the pipeline to fall through to the next strategy.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempts to extract an MCQ from the current document.
 *
 * @param {string[]} strategyOrder - Ordered list of strategy names to try
 * @param {Element}  [root]        - Optional DOM subtree root (default: document)
 * @returns {{ question: string, options: string[], context: string|null, strategyUsed: string } | null}
 */
export function extractMCQ(strategyOrder, root = document) {
  for (const name of strategyOrder) {
    const strategy = STRATEGIES[name];
    if (!strategy) {
      console.warn(`[MCQ Extractor] Unknown strategy: "${name}"`);
      continue;
    }

    try {
      const result = strategy(root);
      if (result && isValidMCQ(result)) {
        console.info(`[MCQ Extractor] Strategy "${name}" succeeded.`);
        return { ...result, strategyUsed: name };
      }
    } catch (err) {
      console.warn(`[MCQ Extractor] Strategy "${name}" threw:`, err);
    }
  }

  console.warn("[MCQ Extractor] All strategies exhausted. No MCQ detected.");
  return null;
}

// Wrap extract to reject false positives (like question palettes)
const originalExtractMCQ = extractMCQ;
export function extractMCQWithValidation(strategyOrder, root = document) {
  const result = originalExtractMCQ(strategyOrder, root);
  if (result && result.options) {
    const numCount = result.options.filter(o => /^\s*\d+\s*$/.test(o)).length;
    if (result.options.length > 12 || (result.options.length > 5 && numCount === result.options.length)) {
      console.warn("[MCQ Extractor] Rejected false positive (likely question palette/grid).");
      return null;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

function isValidMCQ({ question, options }) {
  return (
    typeof question === "string" &&
    question.trim().length > 5 &&
    Array.isArray(options) &&
    options.length >= 2 &&
    options.every((o) => typeof o === "string" && o.trim().length > 0)
  );
}

// ---------------------------------------------------------------------------
// Individual strategies
// ---------------------------------------------------------------------------

/** Strategy 1: data-* attributes */
function strategyDataAttributes(root) {
  const questionEl = root.querySelector("[data-question]");
  if (!questionEl) return null;

  const question = questionEl.dataset.question || questionEl.textContent.trim();
  const optionEls = root.querySelectorAll("[data-option]");
  if (!optionEls.length) return null;

  const options = [...optionEls].map(
    (el) => el.dataset.option || el.textContent.trim()
  );
  const context = root.querySelector("[data-context]")?.textContent.trim() ?? null;

  return { question, options, context };
}

/** Strategy 2: ARIA roles */
function strategyAriaLabels(root) {
  // Try fieldset + legend first
  const fieldsets = root.querySelectorAll("fieldset");
  for (const fs of fieldsets) {
    const legend = fs.querySelector("legend");
    if (!legend) continue;
    const question = legend.textContent.trim();
    const radios = fs.querySelectorAll('[role="radio"], input[type="radio"], input[type="checkbox"]');
    if (!radios.length) continue;
    const options = [...radios].map((el) => {
      const label = root.querySelector(`label[for="${el.id}"]`) || el.closest("label");
      return label ? label.textContent.trim() : el.getAttribute("aria-label") || el.value;
    });
    if (options.length >= 2) return { question, options, context: null };
  }

  // Try aria-labelledby grouping
  const group = root.querySelector('[role="group"], [role="radiogroup"]');
  if (group) {
    const labelId = group.getAttribute("aria-labelledby");
    const questionEl = labelId ? root.getElementById(labelId) : null;
    const question = questionEl?.textContent.trim() || group.getAttribute("aria-label");
    if (!question) return null;
    const items = group.querySelectorAll('[role="radio"], [role="option"], [role="checkbox"]');
    const options = [...items].map((el) => el.textContent.trim() || el.getAttribute("aria-label"));
    if (options.length >= 2) return { question, options, context: null };
  }

  return null;
}

/** Strategy 3: Semantic HTML (fieldset/legend/label) */
function strategySemanticHTML(root) {
  // Already covered partially in aria strategy; this covers plain HTML without ARIA roles
  const legends = root.querySelectorAll("legend");
  for (const legend of legends) {
    const question = legend.textContent.trim();
    const fs = legend.closest("fieldset") || legend.parentElement;
    const labels = fs?.querySelectorAll("label") ?? [];
    if (labels.length < 2) continue;
    const options = [...labels].map((l) => l.textContent.trim()).filter(Boolean);
    if (options.length >= 2) return { question, options, context: null };
  }

  // <label> + <input type="radio"> clusters without fieldset
  const radioInputs = root.querySelectorAll('input[type="radio"]');
  if (radioInputs.length >= 2) {
    const names = new Set([...radioInputs].map((i) => i.name).filter(Boolean));
    for (const name of names) {
      const group = root.querySelectorAll(`input[name="${name}"]`);
      if (group.length < 2) continue;
      const options = [...group].map((inp) => {
        const lbl = root.querySelector(`label[for="${inp.id}"]`) || inp.closest("label");
        return (lbl?.textContent.trim() || inp.value).replace(/^\s*[A-Za-z]\.\s*/, "");
      });
      // Find a preceding question paragraph/heading
      const firstRadio = group[0];
      const question = findPrecedingQuestion(firstRadio, root);
      if (question && options.length >= 2) return { question, options, context: null };
    }
  }

  return null;
}

/** Strategy 4: Class-name heuristics */
function strategyClassNameHeuristics(root) {
  const QUESTION_CLASSES = [
    "question", "question-text", "q-text", "quiz-question",
    "stem", "item-stem", "problem", "prompt",
  ];
  const OPTION_CLASSES = [
    "option", "choice", "answer", "answer-option", "option-text",
    "q-option", "quiz-option", "mcq-option", "radio-label",
  ];

  const questionEl = findByClasses(root, QUESTION_CLASSES);
  if (!questionEl) return null;

  const question = questionEl.textContent.trim();
  const optionEls = findAllByClasses(root, OPTION_CLASSES);
  if (optionEls.length < 2) return null;

  const options = optionEls.map((el) => el.textContent.trim()).filter(Boolean);
  const context = tryFindContext(root);

  return { question, options, context };
}

/** Strategy 5: Generic heuristics (last resort) */
function strategyGenericHeuristics(root) {
  // Find the longest visible paragraph/heading — likely the question
  const candidates = [
    ...root.querySelectorAll("p, h1, h2, h3, h4, h5, h6, span, div"),
  ].filter((el) => {
    const text = el.textContent.trim();
    return (
      text.length > 20 &&
      text.length < 800 &&
      text.includes("?") &&
      isVisible(el) &&
      !el.querySelector("ul, ol, li, input") // Not a container
    );
  });

  if (!candidates.length) return null;

  // Prefer elements containing "?" (actual question)
  const questionEl = candidates.sort((a, b) => {
    const aScore = a.textContent.includes("?") ? 1 : 0;
    const bScore = b.textContent.includes("?") ? 1 : 0;
    return bScore - aScore;
  })[0];

  const question = questionEl.textContent.trim();

  // Look for a nearby list (ol/ul) or set of sibling elements that look like options
  const parent = questionEl.parentElement;
  const listEl = parent?.querySelector("ol, ul") ||
                 questionEl.nextElementSibling?.tagName.match(/^(OL|UL)$/i)
                   ? questionEl.nextElementSibling
                   : null;

  if (listEl) {
    const options = [...listEl.querySelectorAll("li")]
      .map((li) => li.textContent.trim())
      .filter(Boolean);
    if (options.length >= 2) return { question, options, context: null };
  }

  // Try sibling <div>/<p> elements as options
  const siblings = parent
    ? [...parent.children].filter(
        (el) =>
          el !== questionEl &&
          isVisible(el) &&
          el.textContent.trim().length > 0 &&
          el.textContent.trim().length < 300
      )
    : [];

  if (siblings.length >= 2) {
    const options = siblings.map((el) => el.textContent.trim());
    return { question, options, context: null };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function findByClasses(root, classes) {
  for (const cls of classes) {
    const el = root.querySelector(`.${cls}, [class*="${cls}"]`);
    if (el && isVisible(el)) return el;
  }
  return null;
}

function findAllByClasses(root, classes) {
  const results = [];
  const seen = new Set();
  for (const cls of classes) {
    const els = root.querySelectorAll(`.${cls}, [class*="${cls}"]`);
    for (const el of els) {
      if (!seen.has(el) && isVisible(el)) {
        seen.add(el);
        results.push(el);
      }
    }
  }
  return results;
}

function findPrecedingQuestion(el, root) {
  let current = el;
  while (current && current !== root) {
    let sibling = current.previousElementSibling;
    while (sibling) {
      const text = sibling.textContent.trim();
      if (text.length > 10 && (text.includes("?") || /^\d+[.)]\s/.test(text))) {
        return text;
      }
      sibling = sibling.previousElementSibling;
    }
    current = current.parentElement;
  }
  return null;
}

function tryFindContext(root) {
  const contextClasses = ["passage", "context", "reading", "intro", "preamble"];
  for (const cls of contextClasses) {
    const el = root.querySelector(`.${cls}, [class*="${cls}"]`);
    if (el) return el.textContent.trim().slice(0, 500);
  }
  return null;
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0" &&
    el.offsetWidth > 0 &&
    el.offsetHeight > 0
  );
}

// ---------------------------------------------------------------------------
// Strategy registry
// ---------------------------------------------------------------------------

const STRATEGIES = {
  dataAttributes:     strategyDataAttributes,
  ariaLabels:         strategyAriaLabels,
  semanticHTML:       strategySemanticHTML,
  classNameHeuristics: strategyClassNameHeuristics,
  genericHeuristics:  strategyGenericHeuristics,
};
