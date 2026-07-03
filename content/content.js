/**
 * content.js — Content script entry point.
 *
 * Listens for messages from the popup / service worker,
 * orchestrates extraction → LLM → auto-selection → UI display.
 *
 * NOTE: Content scripts cannot use ES module `import` via <script type="module">,
 * so all shared modules are bundled inline here via chrome.runtime.sendMessage
 * pattern (the heavy lifting is done in the background service worker which CAN
 * use ES modules). The content script is the "thin client":
 *   1. Extracts MCQ from DOM (runs in page context)
 *   2. Sends extracted data to background service worker
 *   3. Receives answer back and auto-selects it + shows UI
 */

// ─────────────────────────────────────────────────────────────────────────────
// Inline micro-modules (avoid import issues in non-module content scripts)
// ─────────────────────────────────────────────────────────────────────────────

// ── DOM Extractor (inline copy, kept thin) ──────────────────────────────────
const DOMExtractor = (() => {

  const QUESTION_CLASSES = ["question","question-text","q-text","quiz-question","stem","item-stem","problem","prompt","question-body","questionText"];
  const OPTION_CLASSES   = ["option","choice","answer","answer-option","option-text","q-option","quiz-option","mcq-option","radio-label","optionItem","answer-item"];

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
    const qEl = root.querySelector("[data-question]");
    if (!qEl) return null;
    const question = qEl.dataset.question || qEl.textContent.trim();
    const optEls   = root.querySelectorAll("[data-option]");
    if (optEls.length < 2) return null;
    const options = [...optEls].map(el => el.dataset.option || el.textContent.trim());
    return { question, options, context: root.querySelector("[data-context]")?.textContent.trim() ?? null, strategyUsed: "dataAttributes" };
  }

  function tryAriaLabels(root) {
    for (const fs of root.querySelectorAll("fieldset")) {
      const legend = fs.querySelector("legend");
      if (!legend) continue;
      const radios = fs.querySelectorAll('[role="radio"],input[type="radio"],input[type="checkbox"]');
      if (radios.length < 2) continue;
      const options = [...radios].map(el => {
        const lbl = root.querySelector(`label[for="${el.id}"]`) || el.closest("label");
        return (lbl?.textContent.trim() || el.getAttribute("aria-label") || el.value || "").trim();
      }).filter(Boolean);
      if (options.length >= 2) return { question: legend.textContent.trim(), options, context: null, strategyUsed: "ariaLabels" };
    }
    const group = root.querySelector('[role="group"],[role="radiogroup"]');
    if (group) {
      const qEl = group.getAttribute("aria-labelledby") ? root.getElementById(group.getAttribute("aria-labelledby")) : null;
      const question = qEl?.textContent.trim() || group.getAttribute("aria-label");
      if (question) {
        const options = [...group.querySelectorAll('[role="radio"],[role="option"],[role="checkbox"]')].map(el => el.textContent.trim()).filter(Boolean);
        if (options.length >= 2) return { question, options, context: null, strategyUsed: "ariaLabels" };
      }
    }
    return null;
  }

  function trySemanticHTML(root) {
    for (const legend of root.querySelectorAll("legend")) {
      const fs     = legend.closest("fieldset") || legend.parentElement;
      const labels = [...(fs?.querySelectorAll("label") ?? [])];
      const options = labels.map(l => l.textContent.trim()).filter(Boolean);
      if (options.length >= 2) return { question: legend.textContent.trim(), options, context: null, strategyUsed: "semanticHTML" };
    }
    const radioInputs = root.querySelectorAll('input[type="radio"]');
    if (radioInputs.length >= 2) {
      const names = [...new Set([...radioInputs].map(i => i.name).filter(Boolean))];
      for (const name of names) {
        const group   = [...root.querySelectorAll(`input[name="${name}"]`)];
        const options = group.map(inp => {
          const lbl = root.querySelector(`label[for="${inp.id}"]`) || inp.closest("label");
          return (lbl?.textContent.trim() || inp.value).replace(/^\s*[A-Za-z]\.\s*/,"");
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
    return {
      question: qEl.textContent.trim(),
      options:  optEls.map(el => el.textContent.trim()).filter(Boolean),
      context:  null,
      strategyUsed: "classNameHeuristics"
    };
  }

  function tryGenericHeuristics(root) {
    const candidates = [...root.querySelectorAll("p,h1,h2,h3,h4,h5,h6,span,div")]
      .filter(el => {
        const t = el.textContent.trim();
        return t.length > 20 && t.length < 800 && t.includes("?") && isVisible(el) && !el.querySelector("ul,ol,li,input");
      })
      .sort((a,b) => (b.textContent.includes("?") ? 1 : 0) - (a.textContent.includes("?") ? 1 : 0));
    if (!candidates.length) return null;
    const qEl     = candidates[0];
    const question = qEl.textContent.trim();
    const parent  = qEl.parentElement;
    const nextSib = qEl.nextElementSibling;
    const listEl  = parent?.querySelector("ol,ul") || (nextSib?.tagName.match(/^(OL|UL)$/i) ? nextSib : null);
    if (listEl) {
      const options = [...listEl.querySelectorAll("li")].map(li => li.textContent.trim()).filter(Boolean);
      if (options.length >= 2) return { question, options, context: null, strategyUsed: "genericHeuristics" };
    }
    if (parent) {
      const siblings = [...parent.children]
        .filter(el => el !== qEl && isVisible(el))
        .map(el => el.textContent.trim())
        .filter(t => t.length > 0 && t.length < 300);
      if (siblings.length >= 2) return { question, options: siblings, context: null, strategyUsed: "genericHeuristics" };
    }
    return null;
  }

  // helpers
  function findByClasses(root, classes) {
    for (const cls of classes) {
      const el = root.querySelector(`.${cls},[class*="${cls}"]`);
      if (el && isVisible(el)) return el;
    }
    return null;
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
    const s = window.getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0" && el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  return { extract };
})();

// ── Auto-Selector (inline) ───────────────────────────────────────────────────
const AutoSelector = (() => {

  function select(answerIndex, cfg, root = document) {
    const handlers = [
      tryNativeInput,
      tryAriaRadio,
      tryDataOption,
      tryClassOption,
      tryLabel,
      tryListItem,
    ];
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
    items[idx].setAttribute("aria-checked","true");
    return { success: true, element: items[idx] };
  }
  function tryDataOption(idx, root) {
    const items = root.querySelectorAll("[data-option]");
    if (!items[idx]) return { success: false, element: null };
    items[idx].click();
    return { success: true, element: items[idx] };
  }
  function tryClassOption(idx, root) {
    for (const cls of ["option","choice","answer","answer-option","q-option","quiz-option","mcq-option"]) {
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
    el.style.transition = "all 0.3s ease";
    el.style.outline    = `3px solid ${color}`;
    el.style.boxShadow  = `0 0 12px ${color}88`;
    el.style.backgroundColor = `${color}22`;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => {
      el.style.outline = "";
      el.style.boxShadow = "";
      el.style.backgroundColor = "";
    }, 3000);
  }

  return { select };
})();

// ── Floating Panel (inline Shadow DOM UI) ───────────────────────────────────
const FloatingUI = (() => {
  const PANEL_ID = "mcq-ai-assistant-root";

  function getOrCreate() {
    let host = document.getElementById(PANEL_ID);
    if (host) return host;
    host = document.createElement("div");
    host.id = PANEL_ID;
    Object.assign(host.style, {
      position: "fixed", bottom: "24px", right: "24px",
      zIndex: "2147483647", width: "370px", fontFamily: "sans-serif",
    });
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${styles()}</style><div class="panel"></div>`;
    document.body.appendChild(host);
    return host;
  }

  function setHTML(html) {
    const host = getOrCreate();
    host.shadowRoot.querySelector(".panel").innerHTML = html;
    host.shadowRoot.querySelector(".btn-close")?.addEventListener("click", destroy);
  }

  function destroy() { document.getElementById(PANEL_ID)?.remove(); }

  function showLoading() {
    setHTML(`
      <div class="header">
        <span class="logo">🤖</span><span class="title">MCQ AI Assistant</span>
      </div>
      <div class="body">
        <div class="loader"><div class="spinner"></div><p class="status">Analysing with DeepSeek…</p></div>
      </div>`);
  }

  function showResult({ question, options, answerIndex }) {
    const letter = String.fromCharCode(65 + answerIndex);
    const lis = options.map((opt, i) => {
      const l = String.fromCharCode(65 + i);
      const ok = i === answerIndex;
      return `<li class="opt ${ok ? "opt--ok" : ""}">
        <span class="ltr">${l}</span>
        <span class="txt">${esc(opt)}</span>
        ${ok ? '<span class="badge">✓ AI Pick</span>' : ""}
      </li>`;
    }).join("");

    setHTML(`
      <div class="header">
        <span class="logo">🤖</span><span class="title">MCQ AI Assistant</span>
        <button class="btn-close">✕</button>
      </div>
      <div class="body">
        <p class="question">${esc(trunc(question, 130))}</p>
        <ul class="opts">${lis}</ul>
        <div class="meta"><span class="tag">Answer: <b>${letter}</b></span></div>
      </div>`);
  }

  function showError(msg) {
    setHTML(`
      <div class="header header--err">
        <span class="logo">⚠️</span><span class="title">MCQ AI Assistant</span>
        <button class="btn-close">✕</button>
      </div>
      <div class="body">
        <p class="err">${esc(msg)}</p>
        <p class="hint">Ensure Ollama is running on port 11434 with DeepSeek loaded.</p>
      </div>`);
  }

  function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function trunc(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }

  function styles() {
    return `
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
      .panel{background:linear-gradient(135deg,#0f172a,#1e1b4b);border:1px solid rgba(139,92,246,.4);border-radius:16px;box-shadow:0 25px 60px rgba(0,0,0,.5);overflow:hidden;font-family:'Inter',sans-serif;color:#e2e8f0;font-size:13px;animation:su .35s cubic-bezier(.34,1.56,.64,1)}
      @keyframes su{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
      .header{display:flex;align-items:center;gap:8px;padding:12px 16px;background:linear-gradient(90deg,rgba(139,92,246,.2),rgba(59,130,246,.15));border-bottom:1px solid rgba(255,255,255,.06)}
      .header--err{background:linear-gradient(90deg,rgba(239,68,68,.2),rgba(220,38,38,.1))}
      .logo{font-size:18px}.title{font-size:14px;font-weight:600;color:#c4b5fd;flex:1}
      .btn-close{background:rgba(255,255,255,.08);border:none;color:#94a3b8;width:24px;height:24px;border-radius:6px;cursor:pointer;font-size:12px;transition:all .2s}
      .btn-close:hover{background:rgba(239,68,68,.2);color:#f87171}
      .body{padding:14px 16px}
      .loader{display:flex;flex-direction:column;align-items:center;gap:12px;padding:10px 0}
      .spinner{width:36px;height:36px;border:3px solid rgba(139,92,246,.2);border-top-color:#8b5cf6;border-radius:50%;animation:spin .8s linear infinite}
      @keyframes spin{to{transform:rotate(360deg)}}
      .status{color:#94a3b8;margin:0}
      .question{font-size:13px;font-weight:500;color:#f1f5f9;margin:0 0 12px;line-height:1.5;border-left:3px solid #8b5cf6;padding-left:10px}
      .opts{list-style:none;margin:0 0 12px;padding:0;display:flex;flex-direction:column;gap:6px}
      .opt{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.03)}
      .opt--ok{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.4);box-shadow:0 0 10px rgba(34,197,94,.1)}
      .ltr{min-width:22px;height:22px;background:rgba(139,92,246,.25);color:#c4b5fd;border-radius:5px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px}
      .opt--ok .ltr{background:rgba(34,197,94,.3);color:#4ade80}
      .txt{flex:1;font-size:12px;color:#cbd5e1}
      .badge{font-size:10px;background:#22c55e;color:#052e16;padding:2px 6px;border-radius:100px;font-weight:700;white-space:nowrap}
      .meta{display:flex;gap:8px;flex-wrap:wrap}
      .tag{font-size:11px;color:#64748b;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:100px;padding:2px 8px}
      .tag b{color:#94a3b8}
      .err{color:#f87171;font-weight:500;margin:0 0 8px}
      .hint{color:#64748b;font-size:12px;margin:0}
    `;
  }

  return { showLoading, showResult, showError, destroy };
})();

// ─────────────────────────────────────────────────────────────────────────────
// Main message handler
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "ANALYSE_MCQ") {
    handleAnalyse(sendResponse);
    return true; // keep channel open for async response
  }

  if (msg.action === "PING") {
    sendResponse({ alive: true });
  }
});

async function handleAnalyse(sendResponse) {
  try {
    // 1. Show loading panel immediately
    FloatingUI.showLoading();

    // 2. Extract MCQ from page DOM
    const mcq = DOMExtractor.extract(document);
    if (!mcq) {
      const errMsg = "No MCQ detected on this page. Try clicking inside the question area first.";
      FloatingUI.showError(errMsg);
      sendResponse({ success: false, error: errMsg });
      return;
    }

    // 3. Ask background service worker to call Ollama
    const response = await chrome.runtime.sendMessage({
      action: "CALL_OLLAMA",
      payload: mcq,
    });

    if (!response.success) {
      FloatingUI.showError(response.error || "Unknown error from Ollama.");
      sendResponse({ success: false, error: response.error });
      return;
    }

    const { answerIndex, answerLetter } = response;

    // 4. Auto-select in DOM
    const cfg = response.cfg || { highlightCorrectOption: true, highlightColor: "#22c55e" };
    AutoSelector.select(answerIndex, cfg, document);

    // 5. Show result panel
    FloatingUI.showResult({
      question: mcq.question,
      options:  mcq.options,
      answerIndex,
      answerLetter,
    });

    sendResponse({ success: true, answerIndex, answerLetter });

  } catch (err) {
    const errMsg = err.message || "Unexpected content script error.";
    FloatingUI.showError(errMsg);
    sendResponse({ success: false, error: errMsg });
  }
}

console.info("[MCQ AI Assistant] Content script loaded.");
