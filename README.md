# 🤖 MCQ AI Assistant — Chrome Extension

> **Automatically extracts MCQ questions from your practice portal and selects the correct answer using local Ollama (DeepSeek Coder 6.7B).**

---

## ✨ Features

| Feature | Details |
|---|---|
| 🔍 Smart DOM Extraction | 5-strategy cascade: data attributes → ARIA → semantic HTML → class heuristics → generic |
| 🤖 Local AI via Ollama | Calls DeepSeek Coder 6.7B locally — **no data leaves your machine** |
| ✅ Auto-select Answer | Clicks the correct option in the DOM automatically |
| 🎨 Floating Panel | Shadow-DOM isolated UI that appears on top of any page |
| ⚙️ Configurable | Full settings page: URL, model, timeout, temperature, highlight colour |
| 🔒 Manifest V3 | Fully compliant with Chrome's latest extension standard |

---

## 📁 Project Structure

```
mcq-assistant/
├── manifest.json                 ← MV3 manifest
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── background/
│   └── service-worker.js         ← Calls Ollama API, routes messages
├── content/
│   ├── content.js                ← Injected into pages; orchestrates everything
│   ├── dom-extractor.js          ← 5-strategy DOM extraction (used by content.js inline)
│   ├── auto-selector.js          ← Clicks the right answer (used inline)
│   └── floating-ui.js            ← Shadow DOM floating result panel (used inline)
├── popup/
│   ├── popup.html                ← Extension toolbar popup
│   └── popup.js
├── options/
│   ├── options.html              ← Settings page
│   └── options.js
└── shared/
    ├── config.js                 ← Default settings + chrome.storage helpers
    ├── ollama-client.js          ← Thin Ollama API client
    └── prompt-builder.js         ← Prompt construction + response parsing
```

---

## 🚀 Installation

### 1. Prerequisites

```bash
# Install Ollama
# Windows: https://ollama.com/download

# Pull the model
ollama pull deepseek-coder:6.7b

# Start the server (runs on port 11434 by default)
ollama serve
```

### 2. Load the Extension in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `mcq-assistant/` folder
5. The 🤖 icon appears in your toolbar

---

## 🎯 How to Use

### Method 1 — Toolbar Popup
1. Navigate to your MCQ practice portal
2. Click the 🤖 extension icon in Chrome toolbar
3. The popup checks Ollama status (green dot = online)
4. Click **"✨ Analyse This MCQ"**
5. The floating panel appears showing the answer, and the option is auto-clicked

### Method 2 — Icon Click (no popup)
- If the popup action is `default_popup`, clicking opens the popup
- Alternatively, you can trigger via keyboard shortcut (configurable in `chrome://extensions/shortcuts`)

---

## ⚙️ Configuration

Click **⚙️ Settings** in the popup (or go to `chrome://extensions/` → MCQ AI Assistant → Details → Extension options):

| Setting | Default | Description |
|---|---|---|
| Server URL | `http://localhost:11434` | Your Ollama base URL |
| Model | `deepseek-coder:6.7b` | Any model available in Ollama |
| Timeout | `30000` ms | How long to wait for Ollama response |
| Temperature | `0.1` | Low = deterministic. Recommended for exams |
| Max Tokens | `512` | Maximum response length |
| Highlight Colour | `#22c55e` | Green glow on selected answer |
| Auto-close Panel | `true` | Dismiss floating panel after 8 seconds |
| Primary Strategy | `classNameHeuristics` | Preferred DOM extraction method |

---

## 🔍 DOM Extraction Strategies

The extractor tries each strategy in order until one succeeds:

1. **`dataAttributes`** — Looks for `data-question` and `data-option` attributes  
   → *Best for portals you control*

2. **`ariaLabels`** — Detects `role="radio"`, `<fieldset>/<legend>`, ARIA groups  
   → *Modern accessible portals*

3. **`semanticHTML`** — `<fieldset>`, `<legend>`, `<label>` + `<input type="radio">`  
   → *Standard HTML forms*

4. **`classNameHeuristics`** — Scans for `.question`, `.option`, `.choice`, `.answer` class patterns  
   → *Most quiz platforms*

5. **`genericHeuristics`** — Finds the longest `?`-containing paragraph + nearby list items  
   → *Last resort / unknown portals*

---

## 🧩 Adapting to Your Portal

### If your portal uses custom classes

Open `content/content.js` and extend the arrays at the top of `DOMExtractor`:

```js
const QUESTION_CLASSES = [
  "question", "question-text", /* ... */
  "my-portal-question",   // ← Add your class
];
const OPTION_CLASSES = [
  "option", "choice", /* ... */
  "my-portal-option",     // ← Add your option class
];
```

### If your portal uses data attributes

Add `data-question="..."` to your question element and `data-option="..."` to each option — strategy 1 will pick them up automatically.

### Custom portal selector (advanced)

In `content.js`, replace the `DOMExtractor.extract(document)` call with a targeted call:

```js
const container = document.querySelector(".quiz-container");
const mcq = DOMExtractor.extract(container);
```

---

## 🐞 Troubleshooting

| Problem | Fix |
|---|---|
| **"Ollama not reachable"** | Run `ollama serve` in terminal. Check it's on port 11434 |
| **"No MCQ detected"** | Open DevTools, inspect question element class names and add to QUESTION_CLASSES |
| **Wrong answer selected** | Reduce temperature to `0.0` in Settings. Check model is loaded: `ollama list` |
| **Panel not appearing** | Refresh the page after installing the extension |
| **CORS error in console** | Ollama by default allows all origins. If restricted: `OLLAMA_ORIGINS=* ollama serve` |

---

## 🔐 Privacy

- **Zero external API calls** — everything runs locally via Ollama
- **No data stored** — questions are sent only to `localhost`
- The extension requires `<all_urls>` host permission only to inject the content script into any tab you open

---

## 📜 License

MIT — free to use, modify, and distribute.


## 📝 Changelog

- `6d901e1` feat: init MV3 extension scaffold, manifest and icons
