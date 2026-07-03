/**
 * floating-ui.js — Injects a floating panel into the page showing
 * extraction status, the model's answer, and any error messages.
 *
 * Uses Shadow DOM so the panel is fully isolated from the host page's CSS.
 */

const PANEL_ID = "mcq-assistant-panel";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Creates (or re-uses) the floating panel and sets it to "loading" state. */
export function showLoading() {
  const panel = getOrCreatePanel();
  setContent(panel, loadingTemplate());
}

/** Displays the successful answer result. */
export function showResult({ question, options, answerIndex, answerLetter, rawResponse, strategyUsed }) {
  const panel = getOrCreatePanel();
  setContent(panel, resultTemplate({ question, options, answerIndex, answerLetter, rawResponse, strategyUsed }));
  setupCloseButton(panel);
}

/** Displays an error message. */
export function showError(message) {
  const panel = getOrCreatePanel();
  setContent(panel, errorTemplate(message));
  setupCloseButton(panel);
}

/** Removes the panel from the DOM. */
export function destroyPanel() {
  document.getElementById(PANEL_ID)?.remove();
}

// ---------------------------------------------------------------------------
// Panel lifecycle
// ---------------------------------------------------------------------------

function getOrCreatePanel() {
  let host = document.getElementById(PANEL_ID);
  if (host) return host;

  host = document.createElement("div");
  host.id = PANEL_ID;
  host.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    width: 360px;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
  `;

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${panelStyles()}</style><div class="panel"></div>`;

  document.body.appendChild(host);
  return host;
}

function setContent(host, html) {
  host.shadowRoot.querySelector(".panel").innerHTML = html;
}

function setupCloseButton(host) {
  const btn = host.shadowRoot.querySelector(".btn-close");
  btn?.addEventListener("click", destroyPanel);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function loadingTemplate() {
  return `
    <div class="header">
      <span class="logo">🤖</span>
      <span class="title">MCQ AI Assistant</span>
    </div>
    <div class="body">
      <div class="loader">
        <div class="spinner"></div>
        <p class="status">Analysing question with DeepSeek…</p>
      </div>
    </div>
  `;
}

function resultTemplate({ question, options, answerIndex, answerLetter, strategyUsed }) {
  const optionItems = options
    .map((opt, idx) => {
      const letter = String.fromCharCode(65 + idx);
      const isAnswer = idx === answerIndex;
      return `
        <li class="option ${isAnswer ? "option--correct" : ""}">
          <span class="option-letter">${letter}</span>
          <span class="option-text">${escapeHtml(opt)}</span>
          ${isAnswer ? '<span class="badge">✓ AI Answer</span>' : ""}
        </li>
      `;
    })
    .join("");

  return `
    <div class="header">
      <span class="logo">🤖</span>
      <span class="title">MCQ AI Assistant</span>
      <button class="btn-close" title="Close">✕</button>
    </div>
    <div class="body">
      <p class="question">${escapeHtml(truncate(question, 120))}</p>
      <ul class="options">${optionItems}</ul>
      <div class="meta">
        <span class="tag">Strategy: <b>${strategyUsed}</b></span>
        <span class="tag">Answer: <b>${answerLetter}</b></span>
      </div>
    </div>
  `;
}

function errorTemplate(message) {
  return `
    <div class="header header--error">
      <span class="logo">⚠️</span>
      <span class="title">MCQ AI Assistant</span>
      <button class="btn-close" title="Close">✕</button>
    </div>
    <div class="body">
      <p class="error-msg">${escapeHtml(message)}</p>
      <p class="error-hint">Check the extension options and ensure Ollama is running on port 11434.</p>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Styles (Shadow DOM — fully isolated)
// ---------------------------------------------------------------------------

function panelStyles() {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

    :host { all: initial; }

    .panel {
      background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
      border: 1px solid rgba(139, 92, 246, 0.4);
      border-radius: 16px;
      box-shadow: 0 25px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05) inset;
      overflow: hidden;
      font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px;
      color: #e2e8f0;
      animation: slideUp 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes slideUp {
      from { transform: translateY(20px); opacity: 0; }
      to   { transform: translateY(0);    opacity: 1; }
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      background: linear-gradient(90deg, rgba(139,92,246,0.2), rgba(59,130,246,0.15));
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .header--error { background: linear-gradient(90deg, rgba(239,68,68,0.2), rgba(220,38,38,0.1)); }
    .logo   { font-size: 18px; }
    .title  { font-size: 14px; font-weight: 600; color: #c4b5fd; flex: 1; letter-spacing: 0.3px; }
    .btn-close {
      background: rgba(255,255,255,0.08);
      border: none;
      color: #94a3b8;
      width: 24px; height: 24px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.2s;
    }
    .btn-close:hover { background: rgba(239,68,68,0.2); color: #f87171; }

    /* ── Body ── */
    .body { padding: 14px 16px; }

    /* ── Loading ── */
    .loader { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 10px 0; }
    .spinner {
      width: 36px; height: 36px;
      border: 3px solid rgba(139,92,246,0.2);
      border-top-color: #8b5cf6;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status { color: #94a3b8; margin: 0; font-size: 13px; }

    /* ── Question ── */
    .question {
      font-size: 13px;
      font-weight: 500;
      color: #f1f5f9;
      margin: 0 0 12px;
      line-height: 1.5;
      border-left: 3px solid #8b5cf6;
      padding-left: 10px;
    }

    /* ── Options ── */
    .options { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
      transition: all 0.2s;
    }
    .option--correct {
      background: rgba(34, 197, 94, 0.12);
      border-color: rgba(34, 197, 94, 0.4);
      box-shadow: 0 0 10px rgba(34, 197, 94, 0.1);
    }
    .option-letter {
      min-width: 22px; height: 22px;
      background: rgba(139,92,246,0.25);
      color: #c4b5fd;
      border-radius: 5px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 11px;
    }
    .option--correct .option-letter { background: rgba(34,197,94,0.3); color: #4ade80; }
    .option-text  { flex: 1; font-size: 12px; color: #cbd5e1; }
    .badge {
      font-size: 10px;
      background: #22c55e;
      color: #052e16;
      padding: 2px 6px;
      border-radius: 100px;
      font-weight: 700;
      white-space: nowrap;
    }

    /* ── Meta ── */
    .meta { display: flex; gap: 8px; flex-wrap: wrap; }
    .tag {
      font-size: 11px;
      color: #64748b;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 100px;
      padding: 2px 8px;
    }
    .tag b { color: #94a3b8; }

    /* ── Error ── */
    .error-msg  { color: #f87171; font-weight: 500; margin: 0 0 8px; }
    .error-hint { color: #64748b; font-size: 12px; margin: 0; }
  `;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen) + "…" : str;
}
