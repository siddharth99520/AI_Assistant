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
    return (
      tryDataAttributes(root)    ||
      tryAriaLabels(root)        ||
      trySemanticHTML(root)      ||
      tryClassHeuristics(root)   ||
      tryGenericHeuristics(root) ||
      null
    );
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
  function select(answerIndex, cfg, root = document) {
    const handlers = [tryNativeInput, tryAriaRadio, tryDataOption, tryClassOption, tryLabel, tryListItem];
    for (const h of handlers) {
      const r = h(answerIndex, root);
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
  function tryClassOption(idx, root) {
    for (const cls of ["option","choice","answer","answer-option","q-option","quiz-option","mcq-option","option-item"]) {
      const items = root.querySelectorAll(`.${cls},[class*="${cls}"]`);
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
    const list = root.querySelector("ol,ul");
    if (!list) return { success: false, element: null };
    const items = list.querySelectorAll("li");
    if (!items[idx]) return { success: false, element: null };
    items[idx].click();
    return { success: true, element: items[idx] };
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
    console.log("[MCQ AI] Auto-clicking next button:", el);
    el.click(); // Keep it simple, since manual .click() works perfectly
  }

  function clickNextButton(root) {
    const nextWords = ["next", "continue", "submit & next", "next question", ">", "→"];
    
    // 1. Check standard semantic buttons
    const buttons = root.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button']");
    for (const btn of buttons) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      
      const text = (btn.innerText || btn.value || "").trim().toLowerCase();
      const ariaLabel = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
      
      if (nextWords.includes(text) || nextWords.includes(ariaLabel)) {
        triggerClick(btn);
        return true;
      }
    }
    
    // 2. Check non-semantic elements (divs/spans) used as buttons by looking for specific class names
    const classBtns = root.querySelectorAll(".next-btn, .btn-next, .next_btn, .btn--next");
    for (const btn of classBtns) {
      // Intentionally skipping visibility check here because if it exists, we want to click it.
      triggerClick(btn);
      return true;
    }
    
    console.log("[MCQ AI] Could not find a visible 'Next' button to click.");
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
  let onAnalyse  = null; // callback set by main code

  // ── Public API ─────────────────────────────────────────────────────────────

  function init(analyseCallback) {
    onAnalyse = analyseCallback;
    if (document.getElementById(HOST_ID)) return; // already mounted
    _mount();
  }

  function showLoading() {
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
            <p class="status-text">Analysing with AI…</p>
            <p class="hint-text">Please wait</p>
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
          <p class="idle-text">Ready to analyse the current MCQ on this page.</p>
          <button class="btn-analyse" id="sb-analyse-btn">✨ Analyse MCQ</button>
          <p class="shortcut-hint">or press <kbd>Ctrl+Shift+A</kbd></p>
        </div>
      </div>`);
    _bindClose();
    shadow.getElementById("sb-analyse-btn")?.addEventListener("click", () => {
      if (onAnalyse) onAnalyse();
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
    if (content) content.outerHTML = `<div class="panel-inner" id="sb-panel-content">${html}</div>`;
    // Re-query after replace
    const newContent = shadow.getElementById("sb-panel-content");
    if (newContent) newContent.innerHTML = html;
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

  return { init, open, close, toggle, showIdle, showLoading, showResult, showError };
})();

// ─────────────────────────────────────────────────────────────────────────────
// Main — Bootstrap sidebar & message listener
// ─────────────────────────────────────────────────────────────────────────────

// Mount sidebar as soon as the script loads
SidebarUI.init(runAnalysis);

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
  if (msg.action === "PING") {
    sendResponse({ alive: true });
  }
});

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
  console.log("[MCQ AI] Auto-pilot: waiting for next question to load...");
  
  const checkInterval = setInterval(() => {
    attempts++;
    
    // Give up after 15 seconds (30 attempts * 500ms) or if extension context is lost
    if (!isContextValid() || attempts > 30) {
      clearInterval(checkInterval);
      console.log("[MCQ AI] Auto-pilot stopped: timed out waiting for next question.");
      return;
    }
    
    const mcq = DOMExtractor.extract(document);
    if (mcq && mcq.question && mcq.question !== lastAnalyzedQuestion) {
      clearInterval(checkInterval);
      console.log("[MCQ AI] Auto-pilot: new question detected. Starting analysis.");
      runAnalysis();
    }
  }, 500);
}

async function runAnalysis(sendResponse) {
  SidebarUI.open();
  SidebarUI.showLoading();

  // ── Guard: check if extension context is still alive ─────────────────────
  if (!isContextValid()) {
    SidebarUI.showError(
      "Extension was reloaded.",
      "Please <b>refresh this page (F5)</b> to reconnect the AI Assistant."
    );
    sendResponse?.({ success: false, error: "Extension context invalidated" });
    return;
  }

  try {
    // 1. Extract MCQ from DOM
    const mcq = DOMExtractor.extract(document);
    if (!mcq) {
      const errMsg = "No MCQ detected. Make sure a question is visible on screen.";
      SidebarUI.showError(errMsg, "Try clicking inside the question area, then press Ctrl+Shift+A again.");
      sendResponse?.({ success: false, error: errMsg });
      return;
    }
    
    lastAnalyzedQuestion = mcq.question;

    // 2. Call Ollama via background service worker
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        action:  "CALL_OLLAMA",
        payload: mcq,
      });
    } catch (runtimeErr) {
      // Specifically catch "Extension context invalidated" from chrome.runtime
      if (runtimeErr.message?.includes("Extension context invalidated") ||
          runtimeErr.message?.includes("context invalidated")) {
        SidebarUI.showError(
          "Extension was reloaded — context lost.",
          "<b>Refresh this page (F5)</b> to reconnect the AI Assistant."
        );
        sendResponse?.({ success: false, error: "Extension context invalidated" });
        return;
      }
      throw runtimeErr; // re-throw unexpected errors
    }

    if (!response?.success) {
      SidebarUI.showError(response?.error || "Unknown error from Ollama.");
      sendResponse?.({ success: false, error: response?.error });
      return;
    }

    const { answerIndex, answerLetter } = response;

    // 3. Auto-select the answer in the DOM
    const cfg = response.cfg || { highlightCorrectOption: true, highlightColor: "#22c55e", autoClickNext: false };
    AutoSelector.select(answerIndex, cfg, document);

    console.log("[MCQ AI] Config loaded. autoClickNext is:", cfg.autoClickNext);

    // 4. Auto-click next button if configured
    if (cfg.autoClickNext) {
      const delayMs = cfg.autoClickDelay || 1500;
      setTimeout(() => {
        SidebarUI.close(); // Hide sidebar to prevent any overlay overlap issues
        setTimeout(() => {
          const clicked = AutoSelector.clickNextButton(document);
          if (clicked) {
            waitForNewQuestionAndAnalyze();
          } else {
            console.log("[MCQ AI] Auto-pilot stopped: No Next button found.");
          }
        }, 150); // Small delay after closing sidebar
      }, delayMs);
    }

    // 5. Show result in sidebar
    SidebarUI.showResult({
      question:    mcq.question,
      options:     mcq.options,
      answerIndex,
      answerLetter,
    });

    sendResponse?.({ success: true, answerIndex, answerLetter });

  } catch (err) {
    const errMsg = err.message || "Unexpected error in content script.";
    const hint = errMsg.includes("fetch") || errMsg.includes("network")
      ? "Ollama may be down. Run: <code>$env:OLLAMA_ORIGINS='*'; ollama serve</code>"
      : undefined;
    SidebarUI.showError(errMsg, hint);
    sendResponse?.({ success: false, error: errMsg });
  }
}

console.info("[MCQ AI Assistant v2] Sidebar content script loaded.");
