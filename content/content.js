/**
 * content.js — Content script entry point.
 *
 * v2: Replaced the floating pop-up with a persistent SIDEBAR panel
 * injected directly into the page DOM using Shadow DOM.
 *
 * The sidebar has a visible toggle tab pinned to the right edge of the screen,
 * so it is fully accessible even in strict fullscreen mode.
 *
 * Trigger options:
 *  - Click the 🤖 tab on the right edge of the screen
 *  - Press Ctrl+Shift+A (keyboard shortcut via manifest command)
 *  - Click "Analyse" button inside the sidebar
 */
// ─────────────────────────────────────────────────────────────────────────────
// The content script runs in an isolated world but shares the DOM.
// We cannot easily import ES modules directly due to Manifest V3 limitations
// without setting `type: module` in manifest (which has scoping side effects).
// Since content.js doesn't use `import`, we'll implement a tiny inline logger
// that sends logs to the service worker via messaging to be stored.
// ─────────────────────────────────────────────────────────────────────────────

const Logger = {
  info: (msg, details) => chrome.runtime.sendMessage({ action: "LOG", level: "INFO", context: "Content", message: msg, details }),
  warn: (msg, details) => chrome.runtime.sendMessage({ action: "LOG", level: "WARN", context: "Content", message: msg, details }),
  error: (msg, details) => chrome.runtime.sendMessage({ action: "LOG", level: "ERROR", context: "Content", message: msg, details })
};

// ─────────────────────────────────────────────────────────────────────────────
// DOM Extractor — inline IIFE (content scripts can't use ES module imports)
// ─────────────────────────────────────────────────────────────────────────────
const DOMExtractor = (() => {
  // Extended with portal-specific class names observed from the screenshot
  const QUESTION_CLASSES = [
    "question","question-text","q-text","quiz-question","stem","item-stem",
    "problem","prompt","question-body","questionText","questionContent",
    "question-content","multi-choice-question","question-description",
  ];
  const OPTION_CLASSES = [
    "option","choice","answer","answer-option","option-text","q-option",
    "quiz-option","mcq-option","radio-label","optionItem","answer-item",
    "option-item","answer-choice","option-label",
  ];

  function extract(root = document) {
    const result = (
      tryDataAttributes(root)    ||
      tryAriaLabels(root)        ||
      trySemanticHTML(root)      ||
      tryClassHeuristics(root)   ||
      tryGenericHeuristics(root) ||
      null
    );

    if (result && result.options) {
      // Reject false positives like question palettes/grids
      const numCount = result.options.filter(o => /^\s*\d+\s*$/.test(o)).length;
      if (result.options.length > 12 || (result.options.length > 5 && numCount === result.options.length)) {
        return null; 
      }
    }
    return result;
  }

  function tryDataAttributes(root) {
    const qEls = [...root.querySelectorAll("[data-question]")].filter(isVisible);
    if (!qEls.length) return null;
    const qEl = qEls[0];
    const question = qEl.dataset.question || qEl.textContent.trim();
    const optEls = [...root.querySelectorAll("[data-option]")].filter(isVisible);
    if (optEls.length < 2) return null;
    const options = optEls.map(el => el.dataset.option || el.textContent.trim());
    return { question, options, context: root.querySelector("[data-context]")?.textContent.trim() ?? null, strategyUsed: "dataAttributes" };
  }

  function tryAriaLabels(root) {
    const fieldsets = [...root.querySelectorAll("fieldset")].filter(isVisible);
    for (const fs of fieldsets) {
      const legend = fs.querySelector("legend");
      if (!legend) continue;
      const radios = [...fs.querySelectorAll('[role="radio"],input[type="radio"],input[type="checkbox"]')].filter(isVisible);
      if (radios.length < 2) continue;
      const options = radios.map(el => {
        const lbl = root.querySelector(`label[for="${el.id}"]`) || el.closest("label");
        return (lbl?.textContent.trim() || el.getAttribute("aria-label") || el.value || "").trim();
      }).filter(Boolean);
      if (options.length >= 2) return { question: legend.textContent.trim(), options, context: null, strategyUsed: "ariaLabels" };
    }
    const groups = [...root.querySelectorAll('[role="group"],[role="radiogroup"]')].filter(isVisible);
    for (const group of groups) {
      const qEl = group.getAttribute("aria-labelledby") ? root.getElementById(group.getAttribute("aria-labelledby")) : null;
      const question = qEl?.textContent.trim() || group.getAttribute("aria-label");
      if (question) {
        const options = [...group.querySelectorAll('[role="radio"],[role="option"],[role="checkbox"]')]
          .filter(isVisible)
          .map(el => el.textContent.trim()).filter(Boolean);
        if (options.length >= 2) return { question, options, context: null, strategyUsed: "ariaLabels" };
      }
    }
    return null;
  }

  function trySemanticHTML(root) {
    // fieldset + legend
    const legends = [...root.querySelectorAll("legend")].filter(isVisible);
    for (const legend of legends) {
      const fs     = legend.closest("fieldset") || legend.parentElement;
      const labels = [...(fs?.querySelectorAll("label") ?? [])].filter(isVisible);
      const options = labels.map(l => l.textContent.trim()).filter(Boolean);
      if (options.length >= 2) return { question: legend.textContent.trim(), options, context: null, strategyUsed: "semanticHTML" };
    }
    // radio groups by name
    const radioInputs = root.querySelectorAll('input[type="radio"]');
    if (radioInputs.length >= 2) {
      const names = [...new Set([...radioInputs].map(i => i.name).filter(Boolean))];
      for (const name of names) {
        const group   = [...root.querySelectorAll(`input[name="${name}"]`)];
        const options = group.map(inp => {
          const lbl = root.querySelector(`label[for="${inp.id}"]`) || inp.closest("label");
          return (lbl?.textContent.trim() || inp.value).replace(/^\s*[A-Za-z]\.\s*/, "");
        }).filter(Boolean);
        const question = findPrecedingQuestion(group[0], root);
        if (question && options.length >= 2) return { question, options, context: null, strategyUsed: "semanticHTML" };
      }
    }
    return null;
  }

  function tryClassHeuristics(root) {
    const qEl = findByClasses(root, QUESTION_CLASSES);
    if (!qEl) return null;
    const optEls = findAllByClasses(root, OPTION_CLASSES);
    if (optEls.length < 2) return null;
    return { question: qEl.textContent.trim(), options: optEls.map(el => el.textContent.trim()).filter(Boolean), context: null, strategyUsed: "classNameHeuristics" };
  }

  function tryGenericHeuristics(root) {
    // Find longest visible paragraph/heading that contains "?" or looks like a numbered question
    const candidates = [...root.querySelectorAll("p,h1,h2,h3,h4,h5,h6,span,div")]
      .filter(el => {
        const t = el.textContent.trim();
        return t.length > 20 && t.length < 1000 &&
          (t.includes("?") || /^\d+[.)]\s/.test(t)) &&
          isVisible(el) && !el.querySelector("ul,ol,li,input,button");
      })
      .sort((a, b) => {
        const aScore = (a.textContent.includes("?") ? 2 : 0) + (a.children.length === 0 ? 1 : 0) + getActiveScore(a);
        const bScore = (b.textContent.includes("?") ? 2 : 0) + (b.children.length === 0 ? 1 : 0) + getActiveScore(b);
        return bScore - aScore;
      });

    if (!candidates.length) return null;
    const qEl     = candidates[0];
    const question = qEl.textContent.trim();
    const parent  = qEl.parentElement;
    const nextSib = qEl.nextElementSibling;

    // Try nearby <ol>/<ul>
    const listEl = parent?.querySelector("ol,ul") || (nextSib?.tagName.match(/^(OL|UL)$/i) ? nextSib : null);
    if (listEl) {
      const options = [...listEl.querySelectorAll("li")].map(li => li.textContent.trim()).filter(Boolean);
      if (options.length >= 2) return { question, options, context: null, strategyUsed: "genericHeuristics" };
    }
    // Try sibling elements
    if (parent) {
      const siblings = [...parent.children]
        .filter(el => el !== qEl && isVisible(el))
        .map(el => el.textContent.trim())
        .filter(t => t.length > 0 && t.length < 300);
      if (siblings.length >= 2) return { question, options: siblings, context: null, strategyUsed: "genericHeuristics" };
    }
    return null;
  }

  function getActiveScore(el) {
    let score = 0;
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.className && typeof cur.className === 'string' && /(active|current|show|visible)/i.test(cur.className)) {
        score += 10;
        break; // one boost is enough
      }
      cur = cur.parentElement;
    }
    return score;
  }

  function findByClasses(root, classes) {
    let best = null;
    let bestScore = -1;
    for (const cls of classes) {
      const els = root.querySelectorAll(`.${cls},[class*="${cls}"]`);
      for (const el of els) {
        if (isVisible(el)) {
          const score = getActiveScore(el);
          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        }
      }
    }
    return best;
  }
  function findAllByClasses(root, classes) {
    const results = [], seen = new Set();
    for (const cls of classes) {
      for (const el of root.querySelectorAll(`.${cls},[class*="${cls}"]`)) {
        if (!seen.has(el) && isVisible(el)) { seen.add(el); results.push(el); }
      }
    }
    return results;
  }
  function findPrecedingQuestion(el, root) {
    let cur = el;
    while (cur && cur !== root) {
      let sib = cur.previousElementSibling;
      while (sib) {
        const t = sib.textContent.trim();
        if (t.length > 10 && (t.includes("?") || /^\d+[.)]\s/.test(t))) return t;
        sib = sib.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    return null;
  }
  function isVisible(el) {
    if (!el) return false;
    
    if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;

    // Walk up the tree to check for zero-size containers or hidden ancestors
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const s = window.getComputedStyle(cur);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      
      // If a container has 0 height/width and hides overflow, its children are hidden
      if ((s.overflow === "hidden" || s.overflow === "clip" || s.overflowX === "hidden" || s.overflowY === "hidden") &&
          (cur.offsetWidth === 0 || cur.offsetHeight === 0)) {
        return false;
      }
      cur = cur.parentElement;
    }

    // Check if element is within the viewport bounds (handles carousels/sliders)
    const rect = el.getBoundingClientRect();
    const inViewport = (
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.left <= (window.innerWidth || document.documentElement.clientWidth)
    );
    return inViewport;
  }

  return { extract };
})();

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Selector — inline IIFE
// ─────────────────────────────────────────────────────────────────────────────
const AutoSelector = (() => {
  function select(answerIndex, cfg, expectedCount = 0, root = document) {
    const handlers = [tryNativeInput, tryAriaRadio, tryDataOption, tryClassOption, tryLabel, tryListItem];
    for (const h of handlers) {
      const r = h(answerIndex, root, expectedCount);
      if (r.success) {
        if (cfg.highlightCorrectOption) applyHighlight(r.element, cfg.highlightColor || "#22c55e");
        return { ...r, method: h.name };
      }
    }
    return { success: false, element: null, method: "none" };
  }

  function tryNativeInput(idx, root) {
    const groups = new Map();
    for (const inp of root.querySelectorAll('input[type="radio"],input[type="checkbox"]')) {
      const k = inp.name || "__unnamed__";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(inp);
    }
    for (const inputs of groups.values()) {
      if (inputs[idx]) {
        const inp = inputs[idx];
        inp.checked = true;
        inp.click();
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        inp.dispatchEvent(new Event("input",  { bubbles: true }));
        return { success: true, element: inp };
      }
    }
    return { success: false, element: null };
  }
  function tryAriaRadio(idx, root) {
    const items = root.querySelectorAll('[role="radio"],[role="option"],[role="menuitemradio"]');
    if (!items[idx]) return { success: false, element: null };
    items[idx].click();
    items[idx].setAttribute("aria-checked", "true");
    return { success: true, element: items[idx] };
  }
  function tryDataOption(idx, root) {
    const items = root.querySelectorAll("[data-option]");
    if (!items[idx]) return { success: false, element: null };
    items[idx].click();
    return { success: true, element: items[idx] };
  }
  function tryClassOption(idx, root, expectedCount) {
    for (const cls of ["option","choice","answer","answer-option","q-option","quiz-option","mcq-option","option-item"]) {
      const items = root.querySelectorAll(`.${cls},[class*="${cls}"]`);
      if (items.length === 0) continue;
      // Prevent clicking question palettes (25+ items) if we only expect a few options
      if (expectedCount > 0 && items.length > expectedCount + 4) continue;
      if (items[idx]) { items[idx].click(); return { success: true, element: items[idx] }; }
    }
    return { success: false, element: null };
  }
  function tryLabel(idx, root) {
    const inputs = root.querySelectorAll('input[type="radio"],input[type="checkbox"]');
    if (!inputs[idx]) return { success: false, element: null };
    const inp = inputs[idx];
    const lbl = root.querySelector(`label[for="${inp.id}"]`) || inp.closest("label");
    const target = lbl || inp;
    target.click();
    return { success: true, element: target };
  }
  function tryListItem(idx, root) {
    const lists = root.querySelectorAll("ol,ul");
    for (const list of lists) {
      const items = list.querySelectorAll("li");
      if (items.length >= 2 && items.length <= 8) {
        if (items[idx]) {
          items[idx].click();
          return { success: true, element: items[idx] };
        }
      }
    }
    return { success: false, element: null };
  }

  function applyHighlight(el, color) {
    if (!el) return;
    el.style.transition      = "all 0.35s ease";
    el.style.outline         = `3px solid ${color}`;
    el.style.boxShadow       = `0 0 16px ${color}99`;
    el.style.backgroundColor = `${color}22`;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => {
      el.style.outline = "";
      el.style.boxShadow = "";
      el.style.backgroundColor = "";
    }, 3500);
  }

  function triggerClick(el) {
    if (!el) return;
    Logger.info("Auto-clicking next button:", el.tagName);
    el.click(); // Keep it simple, since manual .click() works perfectly
  }

  function clickNextButton(root) {
    // Primary patterns: multi-word phrases that reliably identify the real "Next" button
    const primaryPatterns = [
      "next", "continue", "submit & next", "submit and next",
      "save & next", "save and next", "next question",
      "submit & continue", "save & continue",
    ];
    // Arrow-only buttons are deprioritized — they often match pagination/palette arrows
    const arrowPatterns = [">", "→", "»", "▶"];

    // 1. Check standard semantic buttons — prefer primary patterns first
    const buttons = root.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button']");
    let arrowFallback = null;

    for (const btn of buttons) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const rawText = (btn.innerText || btn.value || "").trim();
      const text = rawText.toLowerCase();
      const ariaLabel = (btn.getAttribute("aria-label") || "").trim().toLowerCase();

      // Check primary patterns with substring matching (handles "  Save & Next  " etc.)
      const matchesPrimary = primaryPatterns.some(p => text.includes(p) || ariaLabel.includes(p));
      if (matchesPrimary) {
        triggerClick(btn);
        return true;
      }

      // Remember arrow-only buttons as fallback (only if text is very short — likely an icon btn)
      if (!arrowFallback && rawText.length <= 3 && arrowPatterns.some(a => rawText.includes(a))) {
        arrowFallback = btn;
      }
    }

    // 2. Check non-semantic elements (divs/spans) used as buttons by looking for specific class names
    const classBtns = root.querySelectorAll(".next-btn, .btn-next, .next_btn, .btn--next");
    for (const btn of classBtns) {
      // Intentionally skipping visibility check here because if it exists, we want to click it.
      triggerClick(btn);
      return true;
    }

    // 3. Fall back to arrow button only if nothing else worked
    if (arrowFallback) {
      triggerClick(arrowFallback);
      return true;
    }

    Logger.info("Could not find a visible 'Next' button to click.");
    return false;
  }

  return { select, clickNextButton };
})();

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar UI — Shadow DOM, always visible, fullscreen-safe
// ─────────────────────────────────────────────────────────────────────────────
const SidebarUI = (() => {
  const HOST_ID   = "mcq-ai-sidebar-host";
  const SIDEBAR_W = 300; // px — panel content width
  const TAB_W     = 36;  // px — always-visible toggle tab

  let host       = null;
  let shadow     = null;
  let isOpen     = false;
  let onAnalyse  = null; 
  let onSolveCode = null;
  let onRapidFire = null;

  // ── Public API ─────────────────────────────────────────────────────────────

  function init(analyseCallback, solveCodeCallback, rapidFireCallback) {
    onAnalyse = analyseCallback;
    onSolveCode = solveCodeCallback;
    onRapidFire = rapidFireCallback;
    if (document.getElementById(HOST_ID)) return; // already mounted
    _mount();
  }

  function showLoading(statusText = "Analysing with AI…", hintText = "Please wait") {
    _setPanel(`
      <div class="panel-inner">
        <div class="sb-header">
          <span class="sb-logo">🤖</span>
          <span class="sb-title">AI Assistant</span>
          <button class="sb-close" id="sb-close">✕</button>
        </div>
        <div class="sb-body">
          <div class="loader">
            <div class="spinner"></div>
            <p class="status-text">${_esc(statusText)}</p>
            <p class="hint-text">${_esc(hintText)}</p>
          </div>
        </div>
      </div>`);
    _bindClose();
  }

  function showIdle() {
    _setPanel(`
      <div class="panel-inner">
        <div class="sb-header">
          <span class="sb-logo">🤖</span>
          <span class="sb-title">AI Assistant</span>
          <button class="sb-close" id="sb-close">✕</button>
        </div>
        <div class="sb-body">
          <p class="idle-text">Ready to analyse the current question on this page.</p>
          <div style="display: flex; gap: 8px; width: 100%; margin-bottom: 8px;">
            <button class="btn-analyse" id="sb-analyse-btn" style="flex: 1; padding: 12px 0;">✨ Solve MCQ</button>
            <button class="btn-analyse" id="sb-code-btn" style="flex: 1; padding: 12px 0; background: linear-gradient(135deg, #3b82f6, #2563eb);">💻 Solve Code</button>
          </div>
          <button class="btn-rapid-fire" id="sb-rapid-btn">⚡ Rapid Fire</button>
          <p class="shortcut-hint">or press <kbd>Ctrl+Shift+A</kbd> for MCQ</p>
        </div>
      </div>`);
    _bindClose();
    shadow.getElementById("sb-analyse-btn")?.addEventListener("click", () => {
      if (onAnalyse) onAnalyse();
    });
    shadow.getElementById("sb-code-btn")?.addEventListener("click", () => {
      if (onSolveCode) onSolveCode();
    });
    shadow.getElementById("sb-rapid-btn")?.addEventListener("click", () => {
      if (onRapidFire) onRapidFire();
    });
  }

  function showResult({ question, options, answerIndex }) {
    const letter = String.fromCharCode(65 + answerIndex);
    const lis = options.map((opt, i) => {
      const l  = String.fromCharCode(65 + i);
      const ok = i === answerIndex;
      return `<li class="opt ${ok ? "opt--ok" : ""}">
        <span class="ltr">${l}</span>
        <span class="txt">${_esc(opt)}</span>
        ${ok ? '<span class="badge">✓</span>' : ""}
      </li>`;
    }).join("");

    _setPanel(`
      <div class="panel-inner">
        <div class="sb-header">
          <span class="sb-logo">🤖</span>
          <span class="sb-title">AI Assistant</span>
          <button class="sb-close" id="sb-close">✕</button>
        </div>
        <div class="sb-body">
          <div class="answer-badge">
            <span class="answer-label">Answer</span>
            <span class="answer-letter">${letter}</span>
          </div>
          <p class="question-preview">${_esc(_trunc(question, 110))}</p>
          <ul class="opts">${lis}</ul>
          <button class="btn-again" id="sb-again-btn">↺ Next Question</button>
        </div>
      </div>`);
    _bindClose();
    shadow.getElementById("sb-again-btn")?.addEventListener("click", showIdle);
  }

  function showError(msg, hint) {
    // Smart hint: if not provided, show context-appropriate guidance
    const defaultHint = hint || "Check Ollama is running:<br><code>$env:OLLAMA_ORIGINS='*'; ollama serve</code>";
    _setPanel(`
      <div class="panel-inner">
        <div class="sb-header sb-header--err">
          <span class="sb-logo">⚠️</span>
          <span class="sb-title">Error</span>
          <button class="sb-close" id="sb-close">✕</button>
        </div>
        <div class="sb-body">
          <p class="err-msg">${_esc(msg)}</p>
          <p class="err-hint">${defaultHint}</p>
          <button class="btn-again" id="sb-again-btn">↺ Try Again</button>
        </div>
      </div>`);
    _bindClose();
    shadow.getElementById("sb-again-btn")?.addEventListener("click", showIdle);
  }

  function open() {
    if (!host) return;
    isOpen = true;
    shadow.getElementById("sb-wrapper").style.transform = "translateX(0)";
    _getTab().setAttribute("data-open", "true");
    _getTab().title = "Close AI Assistant";
  }

  function close() {
    if (!host) return;
    isOpen = false;
    shadow.getElementById("sb-wrapper").style.transform = `translateX(${SIDEBAR_W}px)`;
    _getTab().removeAttribute("data-open");
    _getTab().title = "Open AI Assistant (Ctrl+Shift+A)";
    // Reset to idle so stale results never show on next open
    showIdle();
  }

  function toggle() { isOpen ? close() : open(); }

  // ── Private ────────────────────────────────────────────────────────────────

  function _mount() {
    host = document.createElement("div");
    host.id = HOST_ID;
    Object.assign(host.style, {
      position:   "fixed",
      top:        "0",
      right:      "0",
      zIndex:     "2147483647",
      height:     "100vh",
      width:      `${SIDEBAR_W + TAB_W}px`,
      pointerEvents: "none",
      fontFamily: "sans-serif",
    });

    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${_styles()}</style>

      <div id="sb-wrapper" style="transform: translateX(${SIDEBAR_W}px)">
        <!-- Toggle Tab (always visible) -->
        <button class="sb-tab" id="sb-tab" title="Open AI Assistant (Ctrl+Shift+A)">
          <span class="tab-icon">🤖</span>
          <span class="tab-label">AI</span>
        </button>

        <!-- Sidebar Panel (slides in/out) -->
        <div class="sidebar" id="sb-panel">
          <div class="panel-inner" id="sb-panel-content">
            <!-- populated by showIdle / showLoading / showResult / showError -->
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(host);

    // Tab click toggles sidebar
    shadow.getElementById("sb-tab").addEventListener("click", () => {
      toggle();
      if (isOpen) showIdle();
    });

    // Close sidebar when user clicks outside it.
    // e.isTrusted filters out programmatic .click() calls (e.g. AutoSelector)
    // e.composedPath() correctly handles Shadow DOM boundaries.
    document.addEventListener("click", (e) => {
      if (!isOpen) return;
      if (!e.isTrusted) return;                          // ignore programmatic clicks
      if (e.composedPath().includes(host)) return;       // ignore clicks inside sidebar
      close();
    }, { capture: true });
  }

  function _setPanel(html) {
    const content = shadow.getElementById("sb-panel-content");
    // Set innerHTML directly — avoids double-render bug where outerHTML + innerHTML
    // would nest the content inside itself, breaking button event listeners.
    if (content) content.innerHTML = html;
  }

  function _bindClose() {
    shadow.getElementById("sb-close")?.addEventListener("click", close);
  }

  function _getSidebar() { return shadow.getElementById("sb-panel"); }
  function _getTab()     { return shadow.getElementById("sb-tab"); }

  function _esc(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }
  function _trunc(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }

  // ── Styles ──────────────────────────────────────────────────────────────────

  function _styles() {
    return `
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      /* ── Wrapper ── */
      #sb-wrapper {
        position: absolute;
        top: 0;
        right: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
      }

      /* ── Toggle Tab ── */
      .sb-tab {
        position: absolute;
        top: 50%;
        left: 0;
        transform: translateY(-50%);
        width: ${TAB_W}px;
        height: 80px;
        background: linear-gradient(180deg, #7c3aed, #4f46e5);
        border: none;
        border-radius: 12px 0 0 12px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
        pointer-events: all;
        box-shadow: -4px 0 20px rgba(124, 58, 237, 0.5);
        transition: width 0.2s ease, background 0.2s;
        z-index: 2;
      }
      .sb-tab:hover {
        background: linear-gradient(180deg, #8b5cf6, #6366f1);
        width: ${TAB_W + 4}px;
      }
      .sb-tab[data-open="true"] {
        background: linear-gradient(180deg, #4f46e5, #3730a3);
        border-radius: 0 0 0 12px;
      }
      .tab-icon { font-size: 16px; line-height: 1; }
      .tab-label {
        font-family: 'Inter', sans-serif;
        font-size: 9px;
        font-weight: 700;
        color: rgba(255,255,255,0.9);
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      /* ── Sidebar Panel ── */
      .sidebar {
        position: absolute;
        top: 0;
        right: 0;
        width: ${SIDEBAR_W}px;
        height: 100vh;
        background: linear-gradient(180deg, #0f172a 0%, #1e1b4b 100%);
        border-left: 1px solid rgba(139, 92, 246, 0.3);
        box-shadow: -8px 0 40px rgba(0, 0, 0, 0.6);
        display: flex;
        flex-direction: column;
        pointer-events: all;
        overflow: hidden;
      }

      /* ── Panel Inner ── */
      .panel-inner {
        display: flex;
        flex-direction: column;
        height: 100%;
        font-family: 'Inter', sans-serif;
        color: #e2e8f0;
        font-size: 13px;
      }

      /* ── Header ── */
      .sb-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 16px 14px 14px;
        background: linear-gradient(90deg, rgba(124,58,237,0.25), rgba(59,130,246,0.15));
        border-bottom: 1px solid rgba(255,255,255,0.07);
        flex-shrink: 0;
      }
      .sb-header--err {
        background: linear-gradient(90deg, rgba(239,68,68,0.2), rgba(220,38,38,0.1));
      }
      .sb-logo  { font-size: 20px; }
      .sb-title { font-size: 14px; font-weight: 700; color: #c4b5fd; flex: 1; letter-spacing: 0.2px; }
      .sb-close {
        width: 26px; height: 26px;
        background: rgba(255,255,255,0.07);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 7px;
        color: #64748b;
        font-size: 12px;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: all 0.2s;
        flex-shrink: 0;
      }
      .sb-close:hover { background: rgba(239,68,68,0.2); color: #f87171; border-color: rgba(239,68,68,0.3); }

      /* ── Body ── */
      .sb-body {
        flex: 1;
        padding: 16px 14px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .sb-body::-webkit-scrollbar { width: 4px; }
      .sb-body::-webkit-scrollbar-track { background: transparent; }
      .sb-body::-webkit-scrollbar-thumb { background: rgba(139,92,246,0.3); border-radius: 2px; }

      /* ── Idle state ── */
      .idle-text {
        font-size: 13px;
        color: #64748b;
        line-height: 1.5;
        padding: 8px 0;
      }
      .btn-analyse {
        width: 100%;
        padding: 13px;
        border-radius: 12px;
        border: none;
        background: linear-gradient(135deg, #7c3aed, #4f46e5);
        color: #fff;
        font-size: 14px;
        font-weight: 600;
        font-family: 'Inter', sans-serif;
        cursor: pointer;
        transition: all 0.25s;
        box-shadow: 0 4px 15px rgba(124,58,237,0.4);
        letter-spacing: 0.2px;
      }
      .btn-analyse:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 22px rgba(124,58,237,0.55);
      }
      .btn-analyse:active { transform: translateY(0); }
      .shortcut-hint {
        text-align: center;
        font-size: 11px;
        color: #334155;
      }
      kbd {
        background: rgba(255,255,255,0.07);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 4px;
        padding: 1px 5px;
        font-family: monospace;
        font-size: 10px;
        color: #64748b;
      }

      /* ── Loading ── */
      .loader {
        display: flex; flex-direction: column;
        align-items: center; gap: 14px;
        padding: 24px 0;
      }
      .spinner {
        width: 40px; height: 40px;
        border: 3px solid rgba(139,92,246,0.2);
        border-top-color: #8b5cf6;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .status-text { color: #94a3b8; font-size: 13px; font-weight: 500; }
      .hint-text   { color: #334155; font-size: 11px; }

      /* ── Answer badge ── */
      .answer-badge {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: linear-gradient(135deg, rgba(34,197,94,0.12), rgba(16,185,129,0.08));
        border: 1px solid rgba(34,197,94,0.3);
        border-radius: 12px;
        padding: 12px 16px;
      }
      .answer-label { font-size: 11px; font-weight: 600; color: #4ade80; text-transform: uppercase; letter-spacing: 0.8px; }
      .answer-letter {
        font-size: 28px;
        font-weight: 800;
        color: #22c55e;
        line-height: 1;
        text-shadow: 0 0 20px rgba(34,197,94,0.5);
      }

      /* ── Question preview ── */
      .question-preview {
        font-size: 12px;
        color: #94a3b8;
        line-height: 1.5;
        border-left: 3px solid rgba(139,92,246,0.5);
        padding-left: 10px;
        font-style: italic;
      }

      /* ── Options list ── */
      .opts {
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .opt {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.05);
        background: rgba(255,255,255,0.02);
        transition: all 0.2s;
      }
      .opt--ok {
        background: rgba(34,197,94,0.1);
        border-color: rgba(34,197,94,0.35);
        box-shadow: 0 0 12px rgba(34,197,94,0.08);
      }
      .ltr {
        min-width: 22px; height: 22px;
        background: rgba(139,92,246,0.2);
        color: #a78bfa;
        border-radius: 6px;
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 700;
      }
      .opt--ok .ltr { background: rgba(34,197,94,0.25); color: #4ade80; }
      .txt { flex: 1; font-size: 12px; color: #94a3b8; line-height: 1.4; }
      .opt--ok .txt { color: #d1fae5; }
      .badge {
        font-size: 10px;
        background: #22c55e;
        color: #052e16;
        padding: 2px 6px;
        border-radius: 100px;
        font-weight: 800;
      }

      /* ── Buttons ── */
      .btn-again {
        width: 100%;
        padding: 10px;
        border-radius: 10px;
        border: 1px solid rgba(139,92,246,0.3);
        background: rgba(139,92,246,0.08);
        color: #a78bfa;
        font-size: 12px;
        font-weight: 500;
        font-family: 'Inter', sans-serif;
        cursor: pointer;
        transition: all 0.2s;
        margin-top: 4px;
      }
      .btn-again:hover { background: rgba(139,92,246,0.2); color: #c4b5fd; }

      /* ── Rapid Fire button ── */
      .btn-rapid-fire {
        width: 100%;
        padding: 11px;
        border-radius: 12px;
        border: none;
        background: linear-gradient(135deg, #f59e0b, #ef4444);
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        font-family: 'Inter', sans-serif;
        cursor: pointer;
        transition: all 0.25s;
        box-shadow: 0 4px 15px rgba(245,158,11,0.4);
        letter-spacing: 0.2px;
      }
      .btn-rapid-fire:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 22px rgba(245,158,11,0.55);
      }
      .btn-rapid-fire:active { transform: translateY(0); }

      /* ── Rapid Fire live panel ── */
      .rf-panel {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
        padding: 20px 0;
      }
      .rf-bolt {
        font-size: 48px;
        animation: rf-pulse 0.6s ease-in-out infinite alternate;
        filter: drop-shadow(0 0 16px rgba(245,158,11,0.7));
      }
      @keyframes rf-pulse {
        from { transform: scale(1); opacity: 0.85; }
        to   { transform: scale(1.15); opacity: 1; }
      }
      .rf-title {
        font-size: 16px;
        font-weight: 700;
        color: #fbbf24;
        text-transform: uppercase;
        letter-spacing: 1.5px;
      }
      .rf-counter {
        font-size: 36px;
        font-weight: 800;
        color: #f59e0b;
        text-shadow: 0 0 20px rgba(245,158,11,0.5);
        line-height: 1;
      }
      .rf-label {
        font-size: 11px;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 0.8px;
      }
      .rf-stop {
        width: 100%;
        padding: 12px;
        border-radius: 12px;
        border: 1px solid rgba(239,68,68,0.5);
        background: rgba(239,68,68,0.12);
        color: #f87171;
        font-size: 13px;
        font-weight: 600;
        font-family: 'Inter', sans-serif;
        cursor: pointer;
        transition: all 0.2s;
      }
      .rf-stop:hover { background: rgba(239,68,68,0.25); color: #fca5a5; }

      /* ── Humanizer typing panel ── */
      .hz-panel {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 14px;
        padding: 20px 0;
      }
      .hz-cursor {
        font-size: 40px;
        animation: hz-blink 0.7s step-end infinite;
        filter: drop-shadow(0 0 14px rgba(34,197,94,0.6));
      }
      @keyframes hz-blink {
        50% { opacity: 0.3; }
      }
      .hz-title {
        font-size: 14px;
        font-weight: 700;
        color: #4ade80;
        letter-spacing: 0.5px;
      }
      .hz-progress-wrap {
        width: 100%;
        height: 6px;
        background: rgba(255,255,255,0.06);
        border-radius: 3px;
        overflow: hidden;
      }
      .hz-progress-bar {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #22c55e, #4ade80);
        border-radius: 3px;
        transition: width 0.15s ease;
      }
      .hz-stats {
        font-size: 12px;
        color: #64748b;
      }
      .hz-stats strong {
        color: #4ade80;
        font-size: 14px;
      }
      .hz-stop {
        width: 100%;
        padding: 10px;
        border-radius: 10px;
        border: 1px solid rgba(239,68,68,0.4);
        background: rgba(239,68,68,0.08);
        color: #f87171;
        font-size: 12px;
        font-weight: 600;
        font-family: 'Inter', sans-serif;
        cursor: pointer;
        transition: all 0.2s;
      }
      .hz-stop:hover { background: rgba(239,68,68,0.2); color: #fca5a5; }

      /* ── Error ── */
      .err-msg {
        color: #f87171;
        font-size: 13px;
        font-weight: 500;
        line-height: 1.5;
      }
      .err-hint {
        color: #475569;
        font-size: 12px;
        line-height: 1.6;
      }
      code {
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 5px;
        padding: 2px 6px;
        font-family: monospace;
        font-size: 11px;
        color: #94a3b8;
      }
    `;
  }

  function showRapidFire(count, onStop) {
    _setPanel(`
      <div class="panel-inner">
        <div class="sb-header">
          <span class="sb-logo">⚡</span>
          <span class="sb-title" style="color: #fbbf24;">Rapid Fire</span>
          <button class="sb-close" id="sb-close">✕</button>
        </div>
        <div class="sb-body">
          <div class="rf-panel">
            <div class="rf-bolt">⚡</div>
            <div class="rf-title">Rapid Fire Active</div>
            <div class="rf-counter" id="rf-count">${count}</div>
            <div class="rf-label">questions answered</div>
          </div>
          <button class="rf-stop" id="rf-stop-btn">⏹ Stop Rapid Fire</button>
        </div>
      </div>`);
    _bindClose();
    shadow.getElementById("rf-stop-btn")?.addEventListener("click", () => {
      if (onStop) onStop();
    });
  }

  function updateRapidFireCount(count) {
    const el = shadow?.getElementById("rf-count");
    if (el) el.textContent = count;
  }

  function showHumanizing(totalChars, onStop) {
    _setPanel(`
      <div class="panel-inner">
        <div class="sb-header">
          <span class="sb-logo">⌨️</span>
          <span class="sb-title" style="color: #4ade80;">Humanizer</span>
          <button class="sb-close" id="sb-close">✕</button>
        </div>
        <div class="sb-body">
          <div class="hz-panel">
            <div class="hz-cursor">⌨️</div>
            <div class="hz-title">Typing code…</div>
            <div class="hz-progress-wrap">
              <div class="hz-progress-bar" id="hz-bar"></div>
            </div>
            <div class="hz-stats">
              <strong id="hz-typed">0</strong> / ${totalChars} chars
            </div>
          </div>
          <button class="hz-stop" id="hz-stop-btn">⏹ Stop Typing</button>
        </div>
      </div>`);
    _bindClose();
    shadow.getElementById("hz-stop-btn")?.addEventListener("click", () => {
      if (onStop) onStop();
    });
  }

  function updateHumanizerProgress(typed, total) {
    const bar = shadow?.getElementById("hz-bar");
    const typedEl = shadow?.getElementById("hz-typed");
    if (bar) bar.style.width = `${Math.round((typed / total) * 100)}%`;
    if (typedEl) typedEl.textContent = typed;
  }

  return { init, open, close, toggle, showIdle, showLoading, showResult, showError, showRapidFire, updateRapidFireCount, showHumanizing, updateHumanizerProgress };
})();

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard Shortcut Engine — loads user-configured keybindings from storage
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SHORTCUTS = {
  solveMcq:        "Ctrl+Shift+M",   // In-page rebindable
  toggleSidebar:   "Ctrl+Shift+S",   // Chrome command (manifest only)
  solveCode:       "Ctrl+Shift+K",   // In-page rebindable
  toggleAutoPilot: "Ctrl+Shift+X",   // Chrome command (manifest only)
  rapidFire:       "Ctrl+Shift+F",   // Rapid Fire — random select + next
  nextQuestion:    "Ctrl+Shift+N",
  reAnalyse:       "Ctrl+Shift+R",
  closeSidebar:    "Escape",
  selectOptionA:   "Alt+A",
  selectOptionB:   "Alt+B",
  selectOptionC:   "Alt+C",
  selectOptionD:   "Alt+D",
  openSettings:    "Ctrl+Shift+P",
  toggleHighlight: "Alt+H",
  toggleStealth:   "Alt+S",   // Stealth mode — no sidebar popup
};

// Current active shortcuts (loaded from storage, fallback to defaults)
let activeShortcuts = { ...DEFAULT_SHORTCUTS };
// Session-level highlight override (null = use config value)
let sessionHighlightOverride = null;

// ─────────────────────────────────────────────────────────────────────────────
// Stealth Mode — solve silently without opening the sidebar
// ─────────────────────────────────────────────────────────────────────────────

/** Session flag. Resets on page refresh. Persisted to sessionStorage so it
 *  survives content-script re-injection within the same tab session. */
let stealthMode = (() => {
  try { return sessionStorage.getItem("mcq-ai-stealth") === "1"; }
  catch { return false; }
})();

function _setStealthMode(value) {
  stealthMode = value;
  try { sessionStorage.setItem("mcq-ai-stealth", value ? "1" : "0"); }
  catch { /* ignore */ }
  _updateStealthTab();
  const state = value ? "ON 👻" : "OFF 👁";
  _showToastNotification(`Stealth ${state}`);
  Logger.info(`Stealth mode: ${state}`);
}

/** Updates the sidebar tab icon/label to reflect stealth state. */
function _updateStealthTab() {
  const hostEl = document.getElementById("mcq-ai-sidebar-host");
  if (!hostEl) return;
  if (stealthMode) {
    // Fully hide the entire sidebar host — tab + panel
    hostEl.style.display = "none";
  } else {
    hostEl.style.display = "";
    // Restore normal tab appearance
    if (hostEl.shadowRoot) {
      const tab = hostEl.shadowRoot.getElementById("sb-tab");
      if (tab) {
        tab.querySelector(".tab-icon").textContent = "🤖";
        tab.querySelector(".tab-label").textContent = "AI";
        tab.style.opacity = "";
        tab.title = "Open AI Assistant (Ctrl+Shift+A)";
      }
    }
  }
}


/**
 * Load shortcuts from chrome.storage.sync and keep them in memory.
 */
function loadShortcuts() {
  if (!isContextValid()) return;
  try {
    chrome.storage.sync.get({ shortcuts: DEFAULT_SHORTCUTS }, (data) => {
      activeShortcuts = { ...DEFAULT_SHORTCUTS, ...(data.shortcuts || {}) };
      Logger.info("Shortcuts loaded", activeShortcuts);
    });
  } catch { /* ignore if context invalidated */ }
}

// Load on init
loadShortcuts();

// Reload when storage changes (e.g. user saves new shortcuts from options page)
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.shortcuts) {
      activeShortcuts = { ...DEFAULT_SHORTCUTS, ...(changes.shortcuts.newValue || {}) };
      Logger.info("Shortcuts updated from storage", activeShortcuts);
    }
  });
} catch { /* ignore */ }

/**
 * Convert a KeyboardEvent into a normalised combo string like "Ctrl+Shift+A" or "Alt+H".
 */
function eventToCombo(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  const key = e.key;
  // Skip if key is undefined or only a modifier key was pressed
  if (!key) return null;
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null;

  if (key === "Escape") {
    parts.length = 0; // Escape stands alone
    parts.push("Escape");
  } else {
    parts.push(key.length === 1 ? key.toUpperCase() : key);
  }

  return parts.join("+");
}

/**
 * Master keydown handler — matches pressed combo against active shortcuts.
 */
document.addEventListener("keydown", (e) => {
  const combo = eventToCombo(e);
  if (!combo) return;

  // Find which action matches
  const action = Object.entries(activeShortcuts).find(([, binding]) => binding === combo)?.[0];
  if (!action) return;

  // Chrome manifest commands (Ctrl+Shift+M/S/K/X) fire via service worker.
  // We also handle solveMcq and solveCode here so they can be rebound from Settings.
  // toggleSidebar and toggleAutoPilot are handled exclusively by the service worker.
  const chromeOnlyCommands = ["toggleSidebar", "toggleAutoPilot"];
  if (chromeOnlyCommands.includes(action)) return;

  // Prevent default browser behaviour for our shortcuts
  e.preventDefault();
  e.stopPropagation();

  Logger.info(`Shortcut fired: ${combo} → ${action}`);

  switch (action) {
    case "solveMcq":
      SidebarUI.open();
      runAnalysis();
      break;

    case "solveCode":
      SidebarUI.open();
      runCodingAnalysis();
      break;

    case "nextQuestion":
      AutoSelector.clickNextButton(document);
      break;

    case "reAnalyse":
      runAnalysis();
      break;

    case "closeSidebar":
      SidebarUI.close();
      break;

    case "selectOptionA":
      _quickSelect(0);
      break;
    case "selectOptionB":
      _quickSelect(1);
      break;
    case "selectOptionC":
      _quickSelect(2);
      break;
    case "selectOptionD":
      _quickSelect(3);
      break;

    case "openSettings":
      if (isContextValid()) {
        chrome.runtime.sendMessage({ action: "OPEN_OPTIONS_PAGE" }).catch(() => {});
      }
      break;

    case "toggleHighlight":
      _toggleHighlightSession();
      break;

    case "toggleStealth":
      _setStealthMode(!stealthMode);
      break;

    case "rapidFire":
      toggleRapidFire();
      break;
  }
}, true); // Use capture phase so we intercept before the page


/**
 * Quick-select an option by index (0=A, 1=B, 2=C, 3=D) with current config.
 */
function _quickSelect(index) {
  const cfg = { highlightCorrectOption: true, highlightColor: "#22c55e" };
  if (isContextValid()) {
    chrome.runtime.sendMessage({ action: "GET_CONFIG" }, (remoteCfg) => {
      if (remoteCfg) {
        cfg.highlightCorrectOption = sessionHighlightOverride ?? remoteCfg.highlightCorrectOption;
        cfg.highlightColor = remoteCfg.highlightColor || "#22c55e";
      }
      const result = AutoSelector.select(index, cfg, document);
      const letter = String.fromCharCode(65 + index);
      Logger.info(`Quick-select option ${letter}: ${result.success ? "✓" : "✗"}`);
    });
  } else {
    AutoSelector.select(index, cfg, document);
  }
}

/**
 * Toggle highlight on/off for the current session.
 */
function _toggleHighlightSession() {
  if (sessionHighlightOverride === null) {
    // First toggle — disable it
    sessionHighlightOverride = false;
  } else {
    sessionHighlightOverride = !sessionHighlightOverride;
  }
  const state = sessionHighlightOverride ? "ON" : "OFF";
  console.info(`[MCQ AI] Highlight toggled: ${state}`);
  // Show brief notification via sidebar
  _showToastNotification(`Highlight ${state}`);
}

/**
 * Shows a brief floating notification inside the sidebar area.
 */
function _showToastNotification(msg) {
  // Use the sidebar's host shadow DOM if available
  const hostEl = document.getElementById("mcq-ai-sidebar-host");
  if (!hostEl || !hostEl.shadowRoot) return;

  const shadow = hostEl.shadowRoot;
  // Remove existing toast if any
  shadow.getElementById("mcq-toast")?.remove();

  const toast = document.createElement("div");
  toast.id = "mcq-toast";
  Object.assign(toast.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    background: "linear-gradient(135deg, #7c3aed, #4f46e5)",
    color: "#fff",
    padding: "10px 20px",
    borderRadius: "12px",
    fontSize: "13px",
    fontWeight: "600",
    fontFamily: "'Inter', sans-serif",
    boxShadow: "0 8px 32px rgba(124,58,237,0.5)",
    zIndex: "2147483647",
    pointerEvents: "none",
    opacity: "0",
    transform: "translateY(10px)",
    transition: "all 0.3s ease",
  });
  toast.textContent = msg;
  shadow.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  });

  // Animate out
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    setTimeout(() => toast.remove(), 300);
  }, 1500);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main — Bootstrap sidebar & message listener
// ─────────────────────────────────────────────────────────────────────────────

// Mount sidebar and restore stealth tab state on init
SidebarUI.init(runAnalysis, runCodingAnalysis, toggleRapidFire);
// Restore stealth tab indicator if stealth was already active
if (stealthMode) _updateStealthTab();


// Listen for messages from popup / service worker / keyboard shortcut
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "ANALYSE_MCQ") {
    SidebarUI.open();
    runAnalysis(sendResponse);
    return true;
  }
  if (msg.action === "TOGGLE_SIDEBAR") {
    SidebarUI.toggle();
    sendResponse({ ok: true });
  }
  if (msg.action === "SOLVE_CODE") {
    SidebarUI.open();
    runCodingAnalysis();
    sendResponse({ ok: true });
  }
  if (msg.action === "TOGGLE_AUTOPILOT") {
    _handleToggleAutoPilot();
    sendResponse({ ok: true });
  }
  if (msg.action === "TOGGLE_RAPID_FIRE") {
    toggleRapidFire();
    sendResponse({ ok: true });
  }
  if (msg.action === "PING") {
    sendResponse({ alive: true });
  }
  if (msg.action === "TOGGLE_STEALTH") {
    _setStealthMode(!stealthMode);
    sendResponse({ ok: true, stealth: stealthMode });
  }
  if (msg.action === "GEMINI_RETRY") {
    // Show a countdown in the sidebar when Gemini 429s and auto-retries
    const { attempt, waitSec, context } = msg;
    const label = context === "coding" ? "Code solver" : "MCQ solver";
    SidebarUI.open();
    SidebarUI.showLoading(
      `⏳ Rate limited by Gemini (429)`,
      `${label} — retry ${attempt}/3 in ${waitSec} s…`
    );
    sendResponse({ ok: true });
  }
});

/**
 * Toggle auto-pilot mode from keyboard shortcut.
 * Reads current config, flips autoClickNext, saves, and shows toast.
 */
async function _handleToggleAutoPilot() {
  if (!isContextValid()) return;
  try {
    const cfg = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: "GET_CONFIG" }, resolve);
    });
    const newValue = !cfg.autoClickNext;
    await new Promise((resolve, reject) => {
      chrome.storage.sync.set({ autoClickNext: newValue }, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
    const state = newValue ? "ON 🚀" : "OFF ⏹";
    Logger.info(`Auto-Pilot toggled: ${state}`);
    _showToastNotification(`Auto-Pilot ${state}`);
  } catch (err) {
    Logger.error("Failed to toggle auto-pilot", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core analysis logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detects if the Chrome extension runtime context is still valid.
 * After an extension reload, old content scripts become "orphaned" and
 * any chrome.runtime call throws "Extension context invalidated".
 */
function isContextValid() {
  try {
    // Accessing chrome.runtime.id throws if context is invalidated
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// Track the last question to detect when the page has successfully navigated
let lastAnalyzedQuestion = null;

function waitForNewQuestionAndAnalyze() {
  let attempts = 0;
  Logger.info("Auto-pilot: waiting for next question to load...");
  
  const checkInterval = setInterval(() => {
    attempts++;
    
    // Give up after 15 seconds (30 attempts * 500ms) or if extension context is lost
    if (!isContextValid() || attempts > 30) {
      clearInterval(checkInterval);
      Logger.warn("Auto-pilot stopped: timed out waiting for next question.");
      return;
    }
    
    const mcq = DOMExtractor.extract(document);
    if (mcq && mcq.question && mcq.question !== lastAnalyzedQuestion) {
      clearInterval(checkInterval);
      Logger.info("Auto-pilot: new question detected. Starting analysis.");
      runAnalysis();
    }
  }, 500);
}

async function runAnalysis(sendResponse) {
  if (!stealthMode) {
    SidebarUI.open();
    SidebarUI.showLoading();
  }

  // ── Guard: check if extension context is still alive ─────────────────────
  if (!isContextValid()) {
    if (!stealthMode) {
      SidebarUI.showError(
        "Extension was reloaded.",
        "Please <b>refresh this page (F5)</b> to reconnect the AI Assistant."
      );
    }
    sendResponse?.({ success: false, error: "Extension context invalidated" });
    return;
  }

  try {
    // 1. Extract MCQ from DOM
    const mcq = DOMExtractor.extract(document);
    if (!mcq) {
      const errMsg = "No MCQ detected. Make sure a question is visible on screen.";
      if (!stealthMode) {
        SidebarUI.showError(errMsg, "Try clicking inside the question area, then press Ctrl+Shift+A again.");
      } else {
        _showToastNotification("⚠ No MCQ found");
      }
      sendResponse?.({ success: false, error: errMsg });
      return;
    }

    lastAnalyzedQuestion = mcq.question;

    // 2. Call AI via background service worker
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        action:  "CALL_OLLAMA",
        payload: mcq,
      });
    } catch (runtimeErr) {
      if (runtimeErr.message?.includes("Extension context invalidated") ||
          runtimeErr.message?.includes("context invalidated")) {
        if (!stealthMode) {
          SidebarUI.showError(
            "Extension was reloaded — context lost.",
            "<b>Refresh this page (F5)</b> to reconnect the AI Assistant."
          );
        }
        sendResponse?.({ success: false, error: "Extension context invalidated" });
        return;
      }
      throw runtimeErr;
    }

    if (!response?.success) {
      if (!stealthMode) {
        SidebarUI.showError(response?.error || "Unknown error from AI provider.");
      } else {
        _showToastNotification(`⚠ ${(response?.error || "AI error").slice(0, 40)}`);
      }
      sendResponse?.({ success: false, error: response?.error });
      return;
    }

    const { answerIndex, answerLetter } = response;

    // 3. Auto-select the answer in the DOM
    const cfg = response.cfg || { highlightCorrectOption: true, highlightColor: "#22c55e", autoClickNext: false };
    if (sessionHighlightOverride !== null) {
      cfg.highlightCorrectOption = sessionHighlightOverride;
    }
    // In stealth mode, suppress highlight glow so nothing visually stands out
    if (stealthMode) cfg.highlightCorrectOption = false;
    AutoSelector.select(answerIndex, cfg, mcq.options.length, document);

    Logger.info(`Config loaded. autoClickNext is: ${cfg.autoClickNext}`);

    if (stealthMode) {
      // Stealth: show a tiny, quick toast and move on
      _showToastNotification(`✓ ${answerLetter}`);
    } else {
      // 4. Auto-click next button if configured
      if (cfg.autoClickNext) {
        const delayMs = cfg.autoClickDelay || 1500;
        setTimeout(() => {
          SidebarUI.close();
          setTimeout(() => {
            const clicked = AutoSelector.clickNextButton(document);
            if (clicked) {
              waitForNewQuestionAndAnalyze();
            } else {
              Logger.warn("Auto-pilot stopped: No Next button found.");
            }
          }, 150);
        }, delayMs);
      }

      // 5. Show result in sidebar
      SidebarUI.showResult({
        question:    mcq.question,
        options:     mcq.options,
        answerIndex,
        answerLetter,
      });
    }

    sendResponse?.({ success: true, answerIndex, answerLetter });

  } catch (err) {
    const errMsg = err.message || "Unexpected error in content script.";
    if (!stealthMode) {
      const hint = errMsg.includes("fetch") || errMsg.includes("network")
        ? "Ollama may be down. Run: <code>$env:OLLAMA_ORIGINS='*'; ollama serve</code>"
        : undefined;
      SidebarUI.showError(errMsg, hint);
    } else {
      _showToastNotification(`⚠ Error`);
      Logger.error(`Stealth analysis error: ${errMsg}`);
    }
    sendResponse?.({ success: false, error: errMsg });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rapid Fire Mode — selects a random option, clicks Next, repeats
// ─────────────────────────────────────────────────────────────────────────────

let rapidFireActive = false;
let rapidFireCount  = 0;
let rapidFireTimer  = null;
let rapidFireSpeed  = 400;   // ms delay between select → Next (loaded from config)

function toggleRapidFire() {
  if (rapidFireActive) {
    stopRapidFire();
  } else {
    startRapidFire();
  }
}

async function startRapidFire() {
  rapidFireActive = true;
  rapidFireCount  = 0;
  rapidFireNoMcqRetries = 0;

  // Load speed from saved config
  try {
    const cfg = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: "GET_CONFIG" }, resolve);
    });
    if (cfg && cfg.rapidFireSpeed) rapidFireSpeed = cfg.rapidFireSpeed;
  } catch (_) { /* keep default */ }

  Logger.info(`⚡ Rapid Fire started (speed: ${rapidFireSpeed}ms)`);
  _showToastNotification("⚡ Rapid Fire ON");
  SidebarUI.open();
  SidebarUI.showRapidFire(0, stopRapidFire);
  _rapidFireStep();
}

function stopRapidFire() {
  rapidFireActive = false;
  if (rapidFireTimer) {
    clearTimeout(rapidFireTimer);
    rapidFireTimer = null;
  }
  Logger.info(`⏹ Rapid Fire stopped after ${rapidFireCount} questions`);
  _showToastNotification(`⏹ Rapid Fire done — ${rapidFireCount} answered`);
  SidebarUI.showIdle();
}

let rapidFireNoMcqRetries = 0;   // tracks consecutive no-option extraction attempts

function _rapidFireStep() {
  if (!rapidFireActive) return;

  // 1. Extract MCQ to find how many options exist
  const mcq = DOMExtractor.extract(document);
  if (!mcq || !mcq.options || mcq.options.length < 2) {
    rapidFireNoMcqRetries++;
    if (rapidFireNoMcqRetries < 4) {
      // Page might still be loading — retry a few times
      _setRapidFireTimer(() => _rapidFireStep(), 600);
      return;
    }
    // Not an MCQ (fill-in-the-blank, essay, etc.) — skip to next question
    Logger.info("⚡ Rapid Fire: no selectable options found, skipping question.");
    rapidFireNoMcqRetries = 0;
    const currentQ = mcq?.question || null;
    const clicked = AutoSelector.clickNextButton(document);
    if (!clicked) {
      Logger.warn("⚡ Rapid Fire: no Next button found on non-MCQ question, stopping.");
      stopRapidFire();
      return;
    }
    _waitForNextQuestionRapidFire(currentQ);
    return;
  }

  rapidFireNoMcqRetries = 0;  // reset on successful extraction

  // 2. Pick a random option
  const randomIdx = Math.floor(Math.random() * mcq.options.length);
  const cfg = { highlightCorrectOption: false };
  
  const selectResult = AutoSelector.select(randomIdx, cfg, mcq.options.length, document);
  // If it couldn't find a valid option to click (e.g. false positive options), skip
  if (!selectResult.success) {
    Logger.info("⚡ Rapid Fire: false positive options, skipping question.");
    const currentQ = mcq?.question || null;
    const clicked = AutoSelector.clickNextButton(document);
    if (!clicked) { stopRapidFire(); return; }
    _waitForNextQuestionRapidFire(currentQ);
    return;
  }
  rapidFireCount++;
  SidebarUI.updateRapidFireCount(rapidFireCount);
  const letter = String.fromCharCode(65 + randomIdx);
  Logger.info(`⚡ Rapid Fire #${rapidFireCount}: selected ${letter}`);

  // 3. Click Next after a short delay, then wait for new question
  _setRapidFireTimer(() => {
    if (!rapidFireActive) return;
    const clicked = AutoSelector.clickNextButton(document);
    if (!clicked) {
      Logger.warn("⚡ Rapid Fire: no Next button found, stopping.");
      stopRapidFire();
      return;
    }
    // 4. Wait for next question to load, then repeat
    _waitForNextQuestionRapidFire(mcq.question);
  }, rapidFireSpeed);
}

/**
 * Waits for the next question to appear in the DOM, using stabilization:
 *  - The extracted question must differ from previousQuestion
 *  - The new question must appear identical in TWO consecutive checks
 *    (prevents acting during mid-transition DOM states)
 */
function _waitForNextQuestionRapidFire(previousQuestion) {
  let attempts = 0;
  let lastSeenQuestion = null;  // For stabilization — must see the same new question twice
  const check = () => {
    if (!rapidFireActive) return;
    attempts++;
    if (attempts > 30) { // 15 seconds timeout
      Logger.warn("⚡ Rapid Fire: timed out waiting for next question.");
      stopRapidFire();
      return;
    }
    const mcq = DOMExtractor.extract(document);
    if (mcq && mcq.question && mcq.question !== previousQuestion) {
      // Stabilization: we saw a new question. Is it the same as last check?
      if (lastSeenQuestion === mcq.question) {
        // DOM has settled — proceed
        _rapidFireStep();
      } else {
        // First time seeing this question — record it and re-check after a short pause
        lastSeenQuestion = mcq.question;
        _setRapidFireTimer(check, 300);
      }
    } else {
      lastSeenQuestion = null;
      _setRapidFireTimer(check, 500);
    }
  };
  _setRapidFireTimer(check, 500);
}

/** Safely sets the rapid-fire timer, clearing any previous one first. */
function _setRapidFireTimer(callback, delayMs) {
  if (rapidFireTimer) clearTimeout(rapidFireTimer);
  rapidFireTimer = setTimeout(callback, delayMs);
}

Logger.info("[MCQ AI Assistant v2] Sidebar content script loaded. In-page shortcuts active.");

// ── Coding Feature Logic ────────────────────────────────────────────────────

async function runCodingAnalysis() {
  if (!stealthMode) {
    SidebarUI.open();
    SidebarUI.showLoading();
  } else {
    _showToastNotification("💻 Solving code…");
  }

  if (!isContextValid()) {
    if (!stealthMode) SidebarUI.showError("Extension was reloaded.", "Please refresh this page.");
    return;
  }

  try {
    const language = detectProgrammingLanguage();
    Logger.info(`Detected language: ${language}`);

    const problemText = extractCodingProblem();
    if (!problemText || problemText.length < 50) {
      if (!stealthMode) {
        SidebarUI.showError("Could not detect coding problem.", "Try highlighting the problem text and click Solve Code again.");
      } else {
        _showToastNotification("⚠ No problem detected");
      }
      return;
    }

    const response = await chrome.runtime.sendMessage({
      action: "CALL_GEMINI_CODE",
      payload: { problemText, language }
    });

    if (!response?.ok) {
      if (!stealthMode) {
        SidebarUI.showError("Code AI Error", response?.error || "Unknown error.");
      } else {
        _showToastNotification(`⚠ Code error`);
      }
      return;
    }

    Logger.info(`Received ${language} code from Gemini:`, response.code.length + " bytes");
    await injectCodeToIDE(response.code, language);

  } catch (err) {
    if (!stealthMode) {
      SidebarUI.showError(err.message || "Unexpected error.");
    } else {
      _showToastNotification("⚠ Code error");
      Logger.error("Stealth coding error", err.message);
    }
  }
}

/**
 * Detects the currently selected programming language from the page UI.
 * Priority: app-language-dropdown → generic <select> → visible text scan → "Java" fallback
 * @returns {string} Normalized language name (e.g. "Java", "C++", "Python", "MySQL")
 */
function detectProgrammingLanguage() {
  const KNOWN = [
    "MySQL", "SQL", "C++", "C#", "TypeScript", "JavaScript",
    "Python 3", "Python", "Kotlin", "Swift", "Scala", "Golang",
    "Go", "Ruby", "PHP", "Rust", "Java", "C",
  ];

  // 1. Portal-specific: app-language-dropdown button text
  const dropBtn = document.querySelector(
    'app-language-dropdown .mydropdown, app-language-dropdown button, app-language-dropdown .selected-lang'
  );
  if (dropBtn) {
    const txt = dropBtn.textContent.trim();
    const match = KNOWN.find(l => txt.toLowerCase().includes(l.toLowerCase()));
    if (match) return match;
  }

  // 2. Generic <select> whose options contain known language names
  for (const select of document.querySelectorAll('select')) {
    const val = select.options[select.selectedIndex]?.text?.trim() || "";
    const match = KNOWN.find(l => val.toLowerCase().includes(l.toLowerCase()));
    if (match) return match;
  }

  // 3. Any visible element explicitly labelled as language selector
  for (const el of document.querySelectorAll('[class*="lang"], [id*="lang"], [data-lang]')) {
    const txt = (el.textContent || el.getAttribute('data-lang') || "").trim();
    const match = KNOWN.find(l => txt.toLowerCase().includes(l.toLowerCase()));
    if (match) return match;
  }

  // 4. Scan visible page text near the IDE area for language mentions
  const editorParent = document.querySelector('.ace_editor, .CodeMirror, [class*="editor"]')?.parentElement;
  if (editorParent) {
    const txt = editorParent.textContent || "";
    const match = KNOWN.find(l => txt.includes(l));
    if (match) return match;
  }

  return "Java"; // safe default
}

function extractCodingProblem() {
  const selection = window.getSelection().toString().trim();
  if (selection) return selection;

  // Clone body, remove editor to avoid reading code/boilerplate as problem
  const clonedBody = document.body.cloneNode(true);
  const editors = clonedBody.querySelectorAll('.ace_editor, .editor-container, testtaking-footer');
  editors.forEach(e => e.remove());

  return clonedBody.innerText;
}

// ─────────────────────────────────────────────────────────────────────────────
// Humanizer — types code character-by-character like a real person
// ─────────────────────────────────────────────────────────────────────────────

let humanizerActive = false;
let humanizerAbort  = null;

function stopHumanizer() {
  humanizerActive = false;
  if (humanizerAbort) humanizerAbort();
}

/**
 * Injects generated code into the Ace Editor using humanized typing.
 * Types character-by-character with natural speed variations.
 * @param {string} code      - Raw code string from AI
 * @param {string} language  - Language name (e.g. "C++", "Python")
 */
async function injectCodeToIDE(code, language = "Java") {
  // 1. Set correct language in the dropdown (portal may need this before editor accepts code)
  const langDropdown = document.querySelector('app-language-dropdown .mydropdown');
  if (langDropdown) {
    langDropdown.click();
    await new Promise(r => setTimeout(r, 200));
    const listItems = document.querySelectorAll('app-language-dropdown span, app-language-dropdown div, app-language-dropdown li');
    for (const item of listItems) {
      if (item.innerText && item.innerText.trim().toLowerCase().includes(language.toLowerCase())) {
        item.click();
        break;
      }
    }
  }

  // 2. Wait for editor to be ready
  await new Promise(r => setTimeout(r, 600));

  const aceInput = document.querySelector('textarea.ace_text-input');
  if (!aceInput) {
    Logger.warn("Ace editor textarea not found.");
    SidebarUI.showError("Editor not found", "Could not find the Ace Editor on this page.");
    return;
  }

  aceInput.focus();
  // Select all (Ctrl+A) and Delete existing content
  aceInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
  aceInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
  await new Promise(r => setTimeout(r, 100));

  // Clean code before typing:
  // 1. Remove markdown code blocks (e.g., ```java ... ```)
  code = code.replace(/^```[a-z]*\n/i, '').replace(/\n```$/i, '').trim();
  // 2. Strip leading spaces from each line to rely on IDE auto-indent and prevent double spaces
  code = code.split('\n').map(line => line.trimStart()).join('\n');

  // 3. Humanized typing — character by character
  humanizerActive = true;
  if (!stealthMode) {
    SidebarUI.open();
    SidebarUI.showHumanizing(code.length, stopHumanizer);
  }
  Logger.info(`⌨️ Humanizer: typing ${code.length} chars of ${language}`);

  for (let i = 0; i < code.length; i++) {
    if (!humanizerActive) {
      Logger.info(`⌨️ Humanizer stopped at char ${i}/${code.length}`);
      break;
    }

    const char = code[i];
    document.execCommand('insertText', false, char);

    // Update progress every 5 chars to avoid UI thrashing
    if (!stealthMode && (i % 5 === 0 || i === code.length - 1)) {
      SidebarUI.updateHumanizerProgress(i + 1, code.length);
    }

    // Variable delay to simulate natural human typing
    let delay;
    if (char === '\n') {
      delay = 80 + Math.random() * 220;   // pause at newlines (thinking)
    } else if (';{}'.includes(char)) {
      delay = 40 + Math.random() * 100;   // slight pause at statement ends
    } else if ('()[]<>'.includes(char)) {
      delay = 15 + Math.random() * 35;    // fast for brackets
    } else if (char === ' ') {
      delay = 10 + Math.random() * 25;    // fast for spaces
    } else {
      delay = 20 + Math.random() * 55;    // normal typing ~40-75ms/char
    }

    await new Promise(r => {
      const timer = setTimeout(r, delay);
      humanizerAbort = () => { clearTimeout(timer); r(); };
    });
  }

  humanizerActive = false;
  humanizerAbort  = null;

  Logger.info(`⌨️ Humanizer complete: ${code.length} chars typed`);
  _showToastNotification(`✓ ${code.length} chars typed (${language})`);
  SidebarUI.showIdle();
}
