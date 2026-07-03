/**
 * auto-selector.js — Clicks / checks the correct answer option in the DOM.
 *
 * Works with:
 *  - <input type="radio"> / <input type="checkbox">
 *  - Clickable <label> elements wrapping inputs
 *  - Custom div/span "radio" buttons (role="radio", data-option, etc.)
 *  - Any element found by the extractor's option index
 */

/**
 * Attempts to select the option at `answerIndex` in the current DOM.
 *
 * @param {number}   answerIndex       - Zero-based index of the correct option
 * @param {string}   strategyUsed      - The extractor strategy that found the MCQ
 * @param {object}   cfg               - Loaded config (highlightCorrectOption, highlightColor)
 * @param {Element}  [root]            - DOM root to search within (default: document)
 * @returns {{ success: boolean, element: Element|null, message: string }}
 */
export function selectAnswer(answerIndex, strategyUsed, cfg, root = document) {
  const handlers = [
    tryNativeRadioCheckbox,
    tryAriaRadio,
    tryDataOptionElements,
    tryClassOptionElements,
    tryLabelElements,
    tryGenericListItems,
  ];

  for (const handler of handlers) {
    const result = handler(answerIndex, root);
    if (result.success) {
      if (cfg.highlightCorrectOption) {
        applyHighlight(result.element, cfg.highlightColor);
      }
      return { ...result, message: `Selected via ${handler.name}` };
    }
  }

  return {
    success: false,
    element: null,
    message: "Could not auto-select answer — manual selection required.",
  };
}

// ---------------------------------------------------------------------------
// Selection handlers
// ---------------------------------------------------------------------------

function tryNativeRadioCheckbox(idx, root) {
  const allGroups = collectRadioGroups(root);
  for (const inputs of allGroups.values()) {
    if (inputs[idx]) {
      const input = inputs[idx];
      input.click();
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input",  { bubbles: true }));
      return { success: true, element: input };
    }
  }
  return { success: false, element: null };
}

function tryAriaRadio(idx, root) {
  const items = root.querySelectorAll(
    '[role="radio"], [role="option"], [role="menuitemradio"]'
  );
  const target = items[idx];
  if (!target) return { success: false, element: null };
  target.click();
  target.setAttribute("aria-checked", "true");
  return { success: true, element: target };
}

function tryDataOptionElements(idx, root) {
  const items = root.querySelectorAll("[data-option]");
  const target = items[idx];
  if (!target) return { success: false, element: null };
  target.click();
  return { success: true, element: target };
}

function tryClassOptionElements(idx, root) {
  const OPTION_CLASSES = [
    "option", "choice", "answer", "answer-option",
    "option-text", "q-option", "quiz-option", "mcq-option",
  ];
  for (const cls of OPTION_CLASSES) {
    const items = root.querySelectorAll(`.${cls}, [class*="${cls}"]`);
    if (items[idx]) {
      items[idx].click();
      return { success: true, element: items[idx] };
    }
  }
  return { success: false, element: null };
}

function tryLabelElements(idx, root) {
  // Labels that wrap or are associated with radio inputs
  const inputs = root.querySelectorAll('input[type="radio"], input[type="checkbox"]');
  if (!inputs[idx]) return { success: false, element: null };
  const inp = inputs[idx];
  const label = root.querySelector(`label[for="${inp.id}"]`) || inp.closest("label");
  const target = label || inp;
  target.click();
  return { success: true, element: target };
}

function tryGenericListItems(idx, root) {
  // Last resort: find the first <ol>/<ul> and click the nth <li>
  const list = root.querySelector("ol, ul");
  if (!list) return { success: false, element: null };
  const items = list.querySelectorAll("li");
  if (!items[idx]) return { success: false, element: null };
  items[idx].click();
  return { success: true, element: items[idx] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Groups all radio inputs by their `name` attribute.
 * Returns a Map<string, HTMLInputElement[]> ordered by DOM position.
 */
function collectRadioGroups(root) {
  const groups = new Map();
  const inputs = root.querySelectorAll('input[type="radio"], input[type="checkbox"]');
  for (const inp of inputs) {
    const key = inp.name || "__unnamed__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(inp);
  }
  return groups;
}

/**
 * Briefly highlights the selected element with a colored outline + glow.
 * Restores original styles after 3 seconds.
 */
function applyHighlight(el, color) {
  if (!el) return;
  const prev = {
    outline: el.style.outline,
    boxShadow: el.style.boxShadow,
    transition: el.style.transition,
    backgroundColor: el.style.backgroundColor,
  };
  el.style.transition = "all 0.3s ease";
  el.style.outline = `3px solid ${color}`;
  el.style.boxShadow = `0 0 12px ${color}88`;
  el.style.backgroundColor = `${color}22`;

  // Scroll into view
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });

  setTimeout(() => {
    el.style.outline      = prev.outline;
    el.style.boxShadow    = prev.boxShadow;
    el.style.backgroundColor = prev.backgroundColor;
  }, 3000);
}
