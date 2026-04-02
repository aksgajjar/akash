'use strict';

// ─── Defaults & State ─────────────────────────────────────────────────────────
const STORAGE_KEY = 'diphoria-ai-v1';

const defaults = {
  ollamaHost:    'localhost',
  defaultModel:  'qwen2.5-coder:7b',
  historyLimit:  25,
  provider:      'none',
  apiKey:        '',
  fontSize:      13,
  wordWrap:      'on',
  minimap:       false,
  safeMode:      true,
  thinkMode:     false,
  learningMode:  true,
  validateMode:  true,
};

const S = {
  settings:          { ...defaults },
  history:           [],
  currentFile:       '',
  lastHtmlBeforeAI:  '',
  isStreaming:       false,
  previewTimer:      null,
  streamCleanup:     [],
  safeMode:          true,
  thinkMode:         false,
  learningMode:      true,
  validateMode:      true,
  pendingImageBase64: null,
  pendingImageName:  '',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let _toastTimer = null;
function showToast(msg, type = '') {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast' + (type ? ' toast-' + type : '');
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(S.settings, JSON.parse(raw));
  } catch {}
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(S.settings));
}

function applySettingsToForm() {
  const map = {
    's-ollama-host':    'ollamaHost',
    's-default-model':  'defaultModel',
    's-history-limit':  'historyLimit',
    's-provider':       'provider',
    's-api-key':        'apiKey',
    's-font-size':      'fontSize',
    's-word-wrap':      'wordWrap',
  };
  for (const [id, key] of Object.entries(map)) {
    const el = $(id);
    if (el) el.value = String(S.settings[key]);
  }
  const minimap = $('s-minimap');
  if (minimap) minimap.checked = !!S.settings.minimap;
}

function readSettingsFromForm() {
  S.settings.ollamaHost   = $('s-ollama-host')  ? $('s-ollama-host').value.trim()   : S.settings.ollamaHost;
  S.settings.defaultModel = $('s-default-model') ? $('s-default-model').value.trim() : S.settings.defaultModel;
  S.settings.historyLimit = $('s-history-limit') ? parseInt($('s-history-limit').value, 10) || 25 : 25;
  S.settings.provider     = $('s-provider')     ? $('s-provider').value             : S.settings.provider;
  S.settings.apiKey       = $('s-api-key')      ? $('s-api-key').value.trim()       : S.settings.apiKey;
  S.settings.fontSize     = $('s-font-size')    ? parseInt($('s-font-size').value, 10) || 13 : 13;
  S.settings.wordWrap     = $('s-word-wrap')    ? $('s-word-wrap').value             : S.settings.wordWrap;
  S.settings.minimap      = $('s-minimap')      ? $('s-minimap').checked             : false;
}

function applySettingsToMonaco(editor) {
  if (!editor) return;
  editor.updateOptions({
    fontSize:  S.settings.fontSize,
    wordWrap:  S.settings.wordWrap,
    minimap:   { enabled: !!S.settings.minimap },
  });
}

// ─── Learning Mode ────────────────────────────────────────────────────────────
const LEARN_KEY = 'diphoria-ai-learning';
const MAX_LEARN = 10;

function loadLearning() {
  try {
    return JSON.parse(localStorage.getItem(LEARN_KEY) || '{"instructions":[],"prefs":{}}');
  } catch {
    return { instructions: [], prefs: {} };
  }
}

function saveLearning(data) {
  localStorage.setItem(LEARN_KEY, JSON.stringify(data));
}

function addToLearning(instruction) {
  const data = loadLearning();
  data.instructions = [instruction, ...data.instructions].slice(0, MAX_LEARN);
  const all = data.instructions.join(' ').toLowerCase();
  if (/dark|dark mode|andhera/.test(all))       data.prefs.theme  = 'dark';
  if (/compact|minimal|chhota/.test(all))       data.prefs.layout = 'compact';
  if (/dashboard|chart|graph/.test(all))        data.prefs.style  = 'dashboard';
  if (/animation|smooth|transition/.test(all))  data.prefs.motion = 'animated';
  if (/clean|format|indent/.test(all))          data.prefs.code   = 'clean';
  saveLearning(data);
  updateLearnBadge(data);
}

function buildLearningContext() {
  const data = loadLearning();
  if (!data.instructions.length) return '';
  let ctx = `Recent instructions (last ${data.instructions.length}):\n`;
  ctx += data.instructions.slice(0, 5).map((ins, i) => `${i + 1}. "${ins}"`).join('\n');
  if (Object.keys(data.prefs).length) {
    ctx += `\nDetected preferences: ${JSON.stringify(data.prefs)}`;
  }
  return ctx;
}

function updateLearnBadge(data) {
  const badge = $('learn-badge');
  if (!badge) return;
  const hasData = data && data.instructions.length > 0;
  badge.classList.toggle('active', hasData);
  if (hasData) badge.title = `Learning: ${data.instructions.length} instructions remembered`;
}

function clearLearning() {
  saveLearning({ instructions: [], prefs: {} });
  updateLearnBadge({ instructions: [], prefs: {} });
  showToast('Learning data cleared');
}

// ─── HTML Validation ──────────────────────────────────────────────────────────
function validateHTML(html) {
  if (!html || !html.trim()) return { valid: false, error: 'Empty content from AI' };
  const trimmed = html.trim();
  if (!/<[^>]+>/.test(trimmed)) return { valid: false, error: 'AI returned text instead of HTML' };
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) return { valid: false, error: 'HTML parse error: ' + parseErr.textContent.slice(0, 80) };
  if (!doc.body || doc.body.innerHTML.trim() === '') {
    return { valid: false, error: 'AI returned empty HTML body' };
  }
  return { valid: true };
}

// ─── Auto Backup ──────────────────────────────────────────────────────────────
function autoBackup(html, instruction) {
  addHistory(`[PRE-EDIT] ${instruction.slice(0, 60)}`, html);
}

// ─── Smart Prompt Engine ──────────────────────────────────────────────────────
function detectSections(html) {
  const sections = [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.querySelector('header, nav, .header, .nav, #header, #nav')) sections.push('header/nav');
  if (doc.querySelector('main, .main, #main, .content, #content'))    sections.push('main content');
  if (doc.querySelector('footer, .footer, #footer'))                  sections.push('footer');
  if (doc.querySelector('.dashboard, #dashboard, .chart, canvas'))    sections.push('dashboard/charts');
  if (doc.querySelector('form, input, .form, #form'))                 sections.push('form/inputs');
  if (doc.querySelector('.hero, #hero, .banner, #banner'))            sections.push('hero/banner');
  if (doc.querySelector('table, .table'))                             sections.push('table');
  if (doc.querySelector('.sidebar, #sidebar, aside'))                 sections.push('sidebar');
  return sections;
}

function buildSystemPrompt(instruction, html) {
  const safeRules = S.safeMode ? `
SAFE EDIT MODE (ACTIVE — MANDATORY):
- Identify the SPECIFIC section the instruction refers to
- Modify ONLY that section — leave everything else EXACTLY as-is
- Preserve ALL: IDs, class names, data attributes, scripts, structure
- If the change would require restructuring >30% of the HTML, describe what you would do instead of making the change
- Add HTML comments where you made changes: <!-- DIPHORIA-EDIT: description -->
` : `
You may modify any part of the HTML needed to fulfill the instruction.
Add HTML comments where you made changes: <!-- DIPHORIA-EDIT: description -->
`;

  const thinkRules = S.thinkMode ? `
THINK MODE (ACTIVE):
Before making changes, output a brief analysis block:
<!-- THINK:
  Section identified: [which section]
  Approach: [what you'll do]
  Risk: [any potential side effects]
-->
Then apply the changes.
` : '';

  const sections = detectSections(html);
  const sectionContext = sections.length > 0
    ? `\nDetected sections in this HTML: ${sections.join(', ')}`
    : '';

  const learnCtx = S.learningMode ? buildLearningContext() : '';
  const learnBlock = learnCtx
    ? `\nUSER PREFERENCES (learned from history — apply gently if relevant):\n${learnCtx}\n`
    : '';

  const imgBlock = S.pendingImageBase64
    ? `\nA REFERENCE IMAGE has been provided. Analyze its layout, spacing, and color scheme. Use as inspiration only — do not copy exactly.\n`
    : '';

  return `You are Diphoria AI — a world-class senior HTML/CSS/JavaScript developer with 10+ years of experience.
You understand instructions in BOTH English and Hindi fluently.

CORE RULES:
1. Return ONLY the complete, updated HTML document — nothing else
2. No markdown code fences, no explanations, no text before or after
3. Start with <!DOCTYPE html> and end with </html>
4. Preserve ALL content that is NOT mentioned in the instruction
${safeRules}${thinkRules}${sectionContext}${learnBlock}${imgBlock}
QUALITY STANDARDS:
- Dark mode → CSS custom properties, not just black backgrounds
- Mobile responsive → proper breakpoints, touch-friendly targets
- Animations → smooth, GPU-accelerated, purposeful
- Clean code → 2-space indentation, logical structure`;
}

// ─── Image Upload ─────────────────────────────────────────────────────────────
async function handleImageUpload(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      S.pendingImageBase64 = e.target.result;
      S.pendingImageName = file.name;
      const strip = $('img-preview-strip');
      const thumb = $('img-preview-thumb');
      const name  = $('img-preview-name');
      if (strip) strip.classList.remove('hidden');
      if (thumb) thumb.src = e.target.result;
      if (name)  name.textContent = file.name;
      const uploadBtn = $('btn-image-upload');
      if (uploadBtn) uploadBtn.classList.add('has-image');
      showToast('Image loaded — AI will use as reference', 'ok');
      resolve(e.target.result);
    };
    reader.readAsDataURL(file);
  });
}

function removeImage() {
  S.pendingImageBase64 = null;
  S.pendingImageName = '';
  const strip = $('img-preview-strip');
  if (strip) strip.classList.add('hidden');
  const uploadBtn = $('btn-image-upload');
  if (uploadBtn) uploadBtn.classList.remove('has-image');
}

// ─── HTML File Upload ─────────────────────────────────────────────────────────
function handleHtmlUpload(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    applyHtmlToEditor(e.target.result);
    S.currentFile = file.name;
    const el = $('filename');
    if (el) el.textContent = file.name;
    showToast('Loaded: ' + file.name, 'ok');
  };
  reader.readAsText(file);
}

// ─── Safe / Think Mode Toggles ────────────────────────────────────────────────
function toggleSafeMode() {
  S.safeMode = !S.safeMode;
  S.settings.safeMode = S.safeMode;
  saveSettings();
  const btn = $('btn-safe-mode');
  if (btn) {
    btn.className = 'mode-badge ' + (S.safeMode ? 'safe-on' : 'safe-off');
    btn.title = S.safeMode ? 'Safe Mode ON — click to disable' : 'Safe Mode OFF — click to enable';
  }
  showToast(S.safeMode ? '🛡 Safe Mode enabled' : '⚠ Safe Mode disabled', S.safeMode ? 'ok' : '');
}

function toggleThinkMode() {
  S.thinkMode = !S.thinkMode;
  S.settings.thinkMode = S.thinkMode;
  saveSettings();
  const btn = $('btn-think-mode');
  if (btn) {
    btn.className = 'mode-badge ' + (S.thinkMode ? 'think-on' : 'think-off');
  }
  showToast(S.thinkMode ? '🧠 Think Mode enabled' : '💨 Think Mode disabled');
}

// ─── Ollama Health ────────────────────────────────────────────────────────────
const BUILTIN_MODELS = ['qwen2.5-coder:7b', 'qwen2.5-coder:14b', 'codellama:7b', 'llama3.2:3b', 'mistral:7b'];

async function checkOllama() {
  const dot   = $('status-dot');
  const label = $('status-label');
  try {
    const ok = await window.api.ollamaCheck();
    if (dot)   { dot.classList.toggle('ok', !!ok); dot.classList.toggle('err', !ok); }
    if (label) label.textContent = ok ? 'Ollama running' : 'Ollama offline';
    if (ok) {
      const models = await window.api.ollamaModels();
      populateModelSelects(models || []);
    }
  } catch {
    if (dot)   { dot.classList.remove('ok'); dot.classList.add('err'); }
    if (label) label.textContent = 'Ollama offline';
  }
}

function populateModelSelects(models) {
  const names  = [...new Set([...BUILTIN_MODELS, ...models.map((m) => (typeof m === 'string' ? m : m.name))])];
  const targets = ['model-select', 's-default-model'];
  for (const id of targets) {
    const sel = $(id);
    if (!sel) continue;
    const current = sel.value || S.settings.defaultModel;
    sel.innerHTML = '';
    for (const n of names) {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      if (n === current) opt.selected = true;
      sel.appendChild(opt);
    }
  }
}

// ─── Preview ──────────────────────────────────────────────────────────────────
function refreshPreview(html) {
  const iframe = $('preview');
  const placeholder = $('pv-placeholder');
  const content = html !== undefined ? html : (window._monacoEditor ? window._monacoEditor.getValue() : '');
  if (!content.trim()) {
    if (placeholder) placeholder.style.display = '';
    if (iframe) iframe.srcdoc = '';
  } else {
    if (placeholder) placeholder.style.display = 'none';
    if (iframe) iframe.srcdoc = content;
  }
  updatePvSize();
}

function schedulePreview() {
  clearTimeout(S.previewTimer);
  S.previewTimer = setTimeout(() => refreshPreview(), 500);
}

function updatePvSize() {
  const sizeEl = $('pv-size');
  if (!sizeEl) return;
  const iframe = $('preview');
  if (!iframe) return;
  const w = iframe.offsetWidth;
  const h = iframe.offsetHeight;
  sizeEl.textContent = `${w} × ${h}`;
}

function setViewport(vp) {
  const iframe = $('preview');
  if (!iframe) return;
  iframe.className = '';
  if (vp !== 'desktop') iframe.classList.add('vp-' + vp);
  $$('[data-vp]').forEach((btn) => btn.classList.toggle('active', btn.dataset.vp === vp));
  updatePvSize();
}

// ─── Chat / AI Streaming ──────────────────────────────────────────────────────
function appendMessage(role, html, extraClass = '') {
  const list = $('chat-messages');
  if (!list) return null;
  const div = document.createElement('div');
  div.className = `chat-bubble ${role}${extraClass ? ' ' + extraClass : ''}`;
  div.innerHTML = html;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
  return div;
}

function cleanupStream() {
  S.streamCleanup.forEach((fn) => { try { fn(); } catch {} });
  S.streamCleanup = [];
}

async function sendMessage() {
  if (S.isStreaming) return;
  const input    = $('chat-input');
  const modelSel = $('model-select');
  if (!input) return;
  const instruction = input.value.trim();
  if (!instruction) return;

  const editor = window._monacoEditor;
  const html = editor ? editor.getValue() : '';
  if (!html.trim()) { showToast('Paste some HTML first', 'err'); return; }

  const model      = modelSel ? modelSel.value : S.settings.defaultModel;
  const ollamaHost = S.settings.ollamaHost || 'localhost';

  // 1. Record to learning
  if (S.learningMode) addToLearning(instruction);

  // 2. Auto backup BEFORE edit
  autoBackup(html, instruction);

  input.value = '';
  input.style.height = 'auto';

  appendMessage('user', `<div class="msg-bubble">${escapeHtml(instruction)}</div>`);

  S.isStreaming = true;
  setSendBusy(true);

  const statusText = S.thinkMode ? 'Analyzing HTML structure...' : 'Thinking...';
  const aiBubble   = appendMessage('ai', `<div class="msg-bubble streaming">${statusText}</div>`, 'streaming');

  let raw        = '';
  let tokenCount = 0;
  S.lastHtmlBeforeAI = html;

  // 3. Build smart system prompt
  const systemPrompt = buildSystemPrompt(instruction, html);

  const onStatus = window.api.onStatus((msg) => {
    if (aiBubble) aiBubble.querySelector('.msg-bubble').textContent = msg;
  });

  const onChunk = window.api.onChunk((chunk) => {
    raw += chunk;
    tokenCount++;
    if (aiBubble) {
      aiBubble.querySelector('.msg-bubble').innerHTML = S.thinkMode
        ? `Analyzing &amp; writing... (${tokenCount} tokens)`
        : `Writing... (${tokenCount} tokens)`;
    }
  });

  const onDone = window.api.onDone((result) => {
    cleanupStream();
    S.isStreaming = false;
    setSendBusy(false);

    const finalRaw  = (result && result.html) ? result.html : raw;
    const resultHTML = extractHtml(finalRaw);

    // 4. Validate HTML
    if (S.validateMode) {
      const validation = validateHTML(resultHTML);
      if (!validation.valid) {
        if (aiBubble) {
          aiBubble.classList.remove('streaming');
          const bubble = aiBubble.querySelector('.msg-bubble');
          if (bubble) {
            bubble.className = 'msg-bubble validation-err';
            bubble.innerHTML = `⚠ Invalid HTML rejected<br><small>${escapeHtml(validation.error)}</small>`;
          }
        }
        showToast('AI returned invalid HTML — change not applied', 'err');
        return;
      }
    }

    // 5. Detect think block
    let displayMsg = '';
    const thinkMatch = resultHTML.match(/<!--\s*THINK:([\s\S]*?)-->/i);
    if (thinkMatch) {
      displayMsg = `<div class="think-block">🧠 ${escapeHtml(thinkMatch[1].trim())}</div>`;
    }

    // 6. Count changes
    const oldLines = html.split('\n').length;
    const newLines = resultHTML.split('\n').length;
    const delta    = newLines - oldLines;
    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
    const editMatches = (resultHTML.match(/DIPHORIA-EDIT:/g) || []).length;
    const editNote = editMatches > 0
      ? ` · ${editMatches} section${editMatches > 1 ? 's' : ''} edited`
      : '';

    displayMsg += `✓ Applied — ${deltaStr} lines${editNote}`;
    if (S.pendingImageBase64) displayMsg += ' · used image reference';

    if (aiBubble) {
      aiBubble.classList.remove('streaming');
      aiBubble.querySelector('.msg-bubble').innerHTML =
        `<div class="msg-bubble">${displayMsg}</div>`;
    }

    // 7. Apply to editor
    addHistory(instruction, resultHTML);
    applyHtmlToEditor(resultHTML);
    refreshPreview(resultHTML);
    showToast('Changes applied by Diphoria AI', 'ok');
  });

  const onError = window.api.onError((err) => {
    cleanupStream();
    S.isStreaming = false;
    setSendBusy(false);
    if (aiBubble) {
      aiBubble.classList.remove('streaming');
      const bubble = aiBubble.querySelector('.msg-bubble');
      if (bubble) {
        bubble.className = 'msg-bubble validation-err';
        bubble.textContent = '✗ ' + err;
      }
    }
    showToast(err, 'err');
  });

  S.streamCleanup = [onStatus, onChunk, onDone, onError];

  window.api.aiStreamStart({
    html,
    instruction,
    model,
    ollamaHost,
    systemPrompt,
    imageBase64: S.pendingImageBase64 || null,
  });
}

function setSendBusy(busy) {
  const btn = $('btn-send');
  if (btn) btn.disabled = busy;
}

function extractHtml(raw) {
  if (!raw) return '';
  // Try to extract from code fences first
  const fence = raw.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  // If it looks like HTML return as-is
  if (raw.trim().startsWith('<')) return raw.trim();
  return raw;
}

function applyHtmlToEditor(html) {
  const editor = window._monacoEditor;
  if (!editor) return;
  const model = editor.getModel();
  if (!model) { editor.setValue(html); return; }
  const range = model.getFullModelRange();
  editor.pushUndoStop();
  model.pushEditOperations([], [{ range, text: html }], () => null);
  editor.pushUndoStop();
}

// ─── Version History ──────────────────────────────────────────────────────────
function addHistory(instruction, html) {
  const entry = {
    id:          Date.now(),
    ts:          new Date().toISOString(),
    instruction: instruction.slice(0, 100),
    html,
  };
  S.history.unshift(entry);
  if (S.history.length > (S.settings.historyLimit || 25)) {
    S.history = S.history.slice(0, S.settings.historyLimit || 25);
  }
  if (window.api && window.api.saveHistory) window.api.saveHistory(S.history);
  renderHistory();
}

function renderHistory() {
  const list  = $('hd-list');
  const badge = $('history-badge');
  if (badge) badge.textContent = S.history.length > 0 ? String(S.history.length) : '';
  if (!list) return;
  if (S.history.length === 0) {
    list.innerHTML = '<div class="hd-empty">No history yet</div>';
    return;
  }
  list.innerHTML = S.history.map((item) => {
    const d = new Date(item.ts);
    const time = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="hd-item" data-id="${item.id}">
      <div class="hd-item-label">${escapeHtml(item.instruction)}</div>
      <div class="hd-item-meta">${time} &middot; ${(item.html.length / 1024).toFixed(1)} KB</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.hd-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id    = Number(el.dataset.id);
      const entry = S.history.find((h) => h.id === id);
      if (!entry) return;
      applyHtmlToEditor(entry.html);
      refreshPreview(entry.html);
      showToast('Version restored');
      closeAllOverlays();
    });
  });
}

// ─── Command Palette ──────────────────────────────────────────────────────────
let paletteOpen = false;
let paletteIdx  = 0;
let paletteFiltered = [];

const COMMANDS = [
  { icon: '\uD83D\uDCC2', label: 'Open File',          hint: 'Load HTML from disk',          shortcut: '\u2318O',   action: () => openFile() },
  { icon: '\uD83D\uDCBE', label: 'Save File',          hint: 'Save HTML to disk',            shortcut: '\u2318S',   action: () => saveFile() },
  { icon: '\uD83C\uDFA8', label: 'Format Code',        hint: 'Beautify HTML indentation',    shortcut: '\u21E7\u2318F', action: () => formatCode() },
  { icon: '\uD83D\uDCCB', label: 'Copy HTML',          hint: 'Copy all to clipboard',        action: () => copyHTML() },
  { icon: '\uD83D\uDDD1', label: 'Clear Editor',       hint: 'Remove all content',           action: () => clearEditor() },
  { icon: '\uD83D\uDDA5', label: 'Desktop Preview',    hint: 'Full width preview',           action: () => setViewport('desktop') },
  { icon: '\uD83D\uDCF1', label: 'Mobile Preview',     hint: '390px mobile view',            action: () => setViewport('mobile') },
  { icon: '\u2699',       label: 'Open Settings',      hint: 'Configure AI and editor',      shortcut: '\u2318,', action: () => openSettings() },
  { icon: '\uD83E\uDD16', label: 'AI: Make dark mode', hint: 'Add professional dark theme',  ai: true, cmd: 'add a polished dark mode with CSS variables' },
  { icon: '\uD83E\uDD16', label: 'AI: Mobile responsive', hint: 'Add breakpoints',           ai: true, cmd: 'make fully mobile responsive with proper breakpoints' },
  { icon: '\uD83E\uDD16', label: 'AI: Clean code',     hint: 'Format and clean up',          ai: true, cmd: 'clean and format the code with consistent indentation' },
  { icon: '\uD83E\uDD16', label: 'AI: Add animations', hint: 'Smooth CSS animations',        ai: true, cmd: 'add smooth CSS animations and transitions' },
  { icon: '\uD83E\uDD16', label: 'AI: Fix layout',     hint: 'Fix spacing and alignment',    ai: true, cmd: 'fix the layout, spacing, and alignment issues' },
  { icon: '🛡',  label: 'Toggle Safe Mode',       hint: 'AI edits only targeted section', action: () => toggleSafeMode() },
  { icon: '🧠',  label: 'Toggle Think Mode',      hint: 'AI analyzes before editing',     action: () => toggleThinkMode() },
  { icon: '📚',  label: 'Clear Learning Data',    hint: 'Reset AI memory',                action: () => clearLearning() },
  { icon: '📂',  label: 'Upload HTML File',       hint: 'Load HTML from file picker',     action: () => { const el = $('html-file-input'); if (el) el.click(); } },
  { icon: '🖼',  label: 'Upload Reference Image', hint: 'AI uses as design reference',    action: () => { const el = $('image-file-input'); if (el) el.click(); } },
];

function openPalette() {
  const overlay = $('palette-overlay');
  const input   = $('palette-input');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  paletteOpen = true;
  if (input) { input.value = ''; input.focus(); }
  renderPalette('');
}

function closePalette() {
  const overlay = $('palette-overlay');
  if (overlay) overlay.classList.add('hidden');
  paletteOpen = false;
}

function renderPalette(query) {
  const list = $('palette-list');
  if (!list) return;
  const q = query.toLowerCase().trim();
  paletteFiltered = q
    ? COMMANDS.filter((c) => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q))
    : [...COMMANDS];

  const showFreeform = q && paletteFiltered.length === 0;
  const freeformItem = showFreeform || q
    ? [{ icon: '\uD83D\uDCAC', label: `Send as AI instruction \u2192 ${query}`, hint: 'Send typed text to AI', _freeform: true, cmd: query }]
    : [];

  const items = q ? [...freeformItem, ...paletteFiltered] : paletteFiltered;
  paletteFiltered = items;
  paletteIdx = 0;

  list.innerHTML = items.map((c, i) => `
    <div class="palette-item${i === 0 ? ' active' : ''}" data-idx="${i}">
      <span class="palette-icon">${c.icon}</span>
      <span class="palette-label">${escapeHtml(c.label)}</span>
      <span class="palette-hint">${escapeHtml(c.hint || '')}</span>
      ${c.shortcut ? `<span class="palette-shortcut">${escapeHtml(c.shortcut)}</span>` : ''}
    </div>
  `).join('');

  list.querySelectorAll('.palette-item').forEach((el) => {
    el.addEventListener('click', () => {
      executePaletteItem(paletteFiltered[Number(el.dataset.idx)]);
    });
    el.addEventListener('mouseenter', () => {
      paletteIdx = Number(el.dataset.idx);
      highlightPaletteItem();
    });
  });
}

function highlightPaletteItem() {
  const list = $('palette-list');
  if (!list) return;
  list.querySelectorAll('.palette-item').forEach((el, i) => {
    el.classList.toggle('active', i === paletteIdx);
  });
  const active = list.querySelector('.palette-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function executePaletteItem(item) {
  if (!item) return;
  closePalette();
  if (item.ai || item._freeform) {
    const input = $('chat-input');
    if (input) {
      input.value = item.cmd;
      input.focus();
      sendMessage();
    }
  } else if (item.action) {
    item.action();
  }
}

// ─── File Operations ──────────────────────────────────────────────────────────
async function openFile() {
  try {
    const result = await window.api.openFile();
    if (!result || !result.content) return;
    applyHtmlToEditor(result.content);
    refreshPreview(result.content);
    if (result.filePath) {
      const parts = result.filePath.split(/[\\/]/);
      S.currentFile = parts[parts.length - 1];
      const fn = $('filename');
      if (fn) fn.textContent = S.currentFile;
    }
    showToast('File opened');
  } catch (e) {
    showToast('Open failed: ' + e.message, 'err');
  }
}

async function saveFile() {
  const editor = window._monacoEditor;
  const html = editor ? editor.getValue() : '';
  if (!html.trim()) { showToast('Nothing to save', 'err'); return; }
  try {
    const result = await window.api.saveFile({ html, suggestedName: S.currentFile || 'index.html' });
    if (result && result.filePath) {
      const parts = result.filePath.split(/[\\/]/);
      S.currentFile = parts[parts.length - 1];
      const fn = $('filename');
      if (fn) fn.textContent = S.currentFile;
      showToast('Saved: ' + S.currentFile, 'ok');
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, 'err');
  }
}

function formatCode() {
  const editor = window._monacoEditor;
  if (!editor) return;
  const action = editor.getAction('editor.action.formatDocument');
  if (action) action.run();
}

function copyHTML() {
  const editor = window._monacoEditor;
  const html = editor ? editor.getValue() : '';
  if (!html) { showToast('Nothing to copy', 'err'); return; }
  navigator.clipboard.writeText(html).then(
    () => showToast('Copied to clipboard', 'ok'),
    () => showToast('Copy failed', 'err')
  );
}

function clearEditor() {
  const editor = window._monacoEditor;
  if (!editor) return;
  applyHtmlToEditor('');
  refreshPreview('');
  const fn = $('filename');
  if (fn) fn.textContent = '';
  S.currentFile = '';
}

function openSettings() {
  const panel = $('settings-overlay') || $('settings-panel');
  if (!panel) return;
  applySettingsToForm();
  panel.classList.remove('hidden');
}

// ─── Resizer ──────────────────────────────────────────────────────────────────
function initResizer() {
  const resizer   = $('resizer');
  const container = resizer && resizer.parentElement;
  if (!resizer || !container) return;

  let dragging  = false;
  let startX    = 0;
  let startLeft = 0;

  resizer.addEventListener('mousedown', (e) => {
    dragging  = true;
    startX    = e.clientX;
    const left = resizer.previousElementSibling;
    startLeft  = left ? left.getBoundingClientRect().width : 0;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const total  = container.getBoundingClientRect().width;
    const delta  = e.clientX - startX;
    const pct    = Math.min(80, Math.max(20, ((startLeft + delta) / total) * 100));
    const left   = resizer.previousElementSibling;
    const right  = resizer.nextElementSibling;
    if (left)  left.style.flex  = `0 0 ${pct}%`;
    if (right) right.style.flex = `0 0 ${100 - pct}%`;
    updatePvSize();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ─── AI Panel Collapse ────────────────────────────────────────────────────────
function toggleAiPanel() {
  const panel = document.querySelector('.ai-panel') || $('ai-panel');
  if (!panel) return;
  panel.classList.toggle('collapsed');
}

// ─── Overlays ─────────────────────────────────────────────────────────────────
function closeAllOverlays() {
  $$('[data-overlay]').forEach((el) => el.classList.add('hidden'));
  closePalette();
}

// ─── Diff View ────────────────────────────────────────────────────────────────
let diffEditor = null;
let diffVisible = false;

function toggleDiff() {
  const container = $('diff-overlay') || $('diff-container');
  if (!container) return;
  diffVisible = !diffVisible;
  container.classList.toggle('hidden', !diffVisible);
  if (diffVisible && window.monaco) {
    const before = S.lastHtmlBeforeAI;
    const after  = window._monacoEditor ? window._monacoEditor.getValue() : '';
    if (!diffEditor) {
      diffEditor = window.monaco.editor.createDiffEditor(container, {
        readOnly:       true,
        renderSideBySide: true,
        theme:          'vs-dark',
      });
    }
    diffEditor.setModel({
      original: window.monaco.editor.createModel(before, 'html'),
      modified: window.monaco.editor.createModel(after,  'html'),
    });
  }
}

// ─── Monaco Initialization ────────────────────────────────────────────────────
function initMonaco() {
  const editorContainer = $('monaco-editor') || $('editor-container') || $('editor');
  if (!editorContainer || editorContainer.tagName === 'TEXTAREA') {
    console.warn('Monaco container not found or is a textarea');
  }

  const target = $('monaco-editor') || $('editor-container') || (() => {
    const div = document.createElement('div');
    div.id = 'monaco-editor';
    div.style.cssText = 'width:100%;height:100%;';
    const area = $('editor');
    if (area && area.parentElement) { area.parentElement.replaceChild(div, area); }
    return div;
  })();

  const editor = window.monaco.editor.create(target, {
    value:               '',
    language:            'html',
    theme:               'vs-dark',
    fontSize:            S.settings.fontSize,
    wordWrap:            S.settings.wordWrap,
    minimap:             { enabled: !!S.settings.minimap },
    formatOnPaste:       true,
    autoIndent:          'full',
    scrollBeyondLastLine: false,
    tabSize:             2,
    automaticLayout:     true,
  });

  window._monacoEditor = editor;

  // Cursor position → #line-info
  editor.onDidChangeCursorPosition((e) => {
    const info = $('line-info');
    if (info) info.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  });

  // Content change → debounced preview + char count
  editor.onDidChangeModelContent(() => {
    const cc = $('char-count');
    if (cc) cc.textContent = editor.getValue().length.toLocaleString() + ' chars';
    schedulePreview();
  });

  // Wire settings save
  const saveBtn = $('btn-save-settings') || $('settings-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      readSettingsFromForm();
      saveSettings();
      applySettingsToMonaco(editor);
      showToast('Settings saved', 'ok');
      const panel = $('settings-overlay') || $('settings-panel');
      if (panel) panel.classList.add('hidden');
    });
  }

  refreshPreview();
}

// ─── Welcome state ────────────────────────────────────────────────────────────
function showWelcome() {
  const placeholder = $('pv-placeholder');
  if (placeholder) placeholder.style.display = '';
}

// ─── Load History ─────────────────────────────────────────────────────────────
async function loadHistoryData() {
  try {
    const h = await window.api.getHistory();
    S.history = Array.isArray(h) ? h : [];
  } catch {
    S.history = [];
  }
  renderHistory();
}

// ─── Event Wiring ─────────────────────────────────────────────────────────────
function wireEvents() {
  // Viewport buttons
  $$('[data-vp]').forEach((btn) => {
    btn.addEventListener('click', () => setViewport(btn.dataset.vp));
  });

  // Resizer
  initResizer();

  // AI panel collapse
  const collapseBtn = $('btn-collapse-ai');
  if (collapseBtn) collapseBtn.addEventListener('click', toggleAiPanel);
  const toggleBar = $('ai-panel-toggle');
  if (toggleBar) toggleBar.addEventListener('click', toggleAiPanel);

  // Chat input send
  const chatInput = $('chat-input');
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
      if (e.key === 'Tab') { e.preventDefault(); const s = chatInput.selectionStart, en = chatInput.selectionEnd; chatInput.value = chatInput.value.slice(0, s) + '  ' + chatInput.value.slice(en); chatInput.selectionStart = chatInput.selectionEnd = s + 2; }
    });
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      const lines = Math.min(5, Math.max(1, chatInput.scrollHeight / 22));
      chatInput.style.height = (lines * 22) + 'px';
    });
  }

  const sendBtn = $('btn-send');
  if (sendBtn) sendBtn.addEventListener('click', sendMessage);

  // Example chips
  $$('.chip[data-cmd]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const input = $('chat-input');
      if (input) { input.value = chip.dataset.cmd; input.focus(); }
    });
  });

  // Palette
  const paletteBtn = $('btn-palette');
  if (paletteBtn) paletteBtn.addEventListener('click', openPalette);
  const paletteOverlay = $('palette-overlay');
  if (paletteOverlay) {
    paletteOverlay.addEventListener('click', (e) => { if (e.target === paletteOverlay) closePalette(); });
  }
  const paletteInput = $('palette-input');
  if (paletteInput) {
    paletteInput.addEventListener('input', () => renderPalette(paletteInput.value));
    paletteInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); paletteIdx = Math.min(paletteIdx + 1, paletteFiltered.length - 1); highlightPaletteItem(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIdx = Math.max(0, paletteIdx - 1); highlightPaletteItem(); }
      else if (e.key === 'Enter') { e.preventDefault(); executePaletteItem(paletteFiltered[paletteIdx]); }
      else if (e.key === 'Escape') { closePalette(); }
    });
  }

  // History clear
  const clearHistBtn = $('btn-clear-history');
  if (clearHistBtn) {
    clearHistBtn.addEventListener('click', () => {
      S.history = [];
      if (window.api && window.api.saveHistory) window.api.saveHistory([]);
      renderHistory();
      showToast('History cleared');
    });
  }

  // Diff button
  const diffBtn = $('btn-diff');
  if (diffBtn) diffBtn.addEventListener('click', toggleDiff);

  // Settings open button
  const settingsBtn = $('btn-settings') || $('btn-open-settings');
  if (settingsBtn) settingsBtn.addEventListener('click', openSettings);

  // Settings overlay close
  const settingsOverlay = $('settings-overlay') || $('settings-panel');
  if (settingsOverlay) {
    const closeBtn = settingsOverlay.querySelector('[data-close], .close-btn, #btn-close-settings');
    if (closeBtn) closeBtn.addEventListener('click', () => settingsOverlay.classList.add('hidden'));
    settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden'); });
  }

  // Upload HTML file
  const htmlInput = $('html-file-input');
  if (htmlInput) htmlInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleHtmlUpload(e.target.files[0]);
    htmlInput.value = '';
  });
  const btnUpload = $('btn-upload');
  if (btnUpload) btnUpload.addEventListener('click', () => {
    const el = $('html-file-input');
    if (el) el.click();
  });

  // Image upload
  const imgInput = $('image-file-input');
  if (imgInput) imgInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleImageUpload(e.target.files[0]);
    imgInput.value = '';
  });
  const btnImg = $('btn-image-upload');
  if (btnImg) btnImg.addEventListener('click', () => {
    const el = $('image-file-input');
    if (el) el.click();
  });
  const btnRmImg = $('btn-remove-image');
  if (btnRmImg) btnRmImg.addEventListener('click', removeImage);

  // Safe / Think mode toggles
  const btnSafe = $('btn-safe-mode');
  if (btnSafe) btnSafe.addEventListener('click', toggleSafeMode);
  const btnThink = $('btn-think-mode');
  if (btnThink) btnThink.addEventListener('click', toggleThinkMode);

  // Drag-and-drop on editor panel
  const edPanel = $('ed-panel');
  if (edPanel) {
    edPanel.addEventListener('dragover', (e) => {
      e.preventDefault();
      edPanel.style.outline = '2px dashed var(--accent)';
    });
    edPanel.addEventListener('dragleave', () => {
      edPanel.style.outline = '';
    });
    edPanel.addEventListener('drop', (e) => {
      e.preventDefault();
      edPanel.style.outline = '';
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (file.name.match(/\.html?$/i)) handleHtmlUpload(file);
      else if (file.type.startsWith('image/')) handleImageUpload(file);
    });
  }

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'o') { e.preventDefault(); openFile(); return; }
    if (mod && e.key === 's') { e.preventDefault(); saveFile(); return; }
    if (mod && e.key === 'k') { e.preventDefault(); paletteOpen ? closePalette() : openPalette(); return; }
    if (mod && e.key === ',') { e.preventDefault(); openSettings(); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); sendMessage(); return; }
    if (mod && e.shiftKey && e.key === 'F') { e.preventDefault(); formatCode(); return; }
    if (e.key === 'Escape') { closeAllOverlays(); return; }
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
(function boot() {
  loadSettings();

  S.safeMode     = S.settings.safeMode     !== false;
  S.thinkMode    = !!S.settings.thinkMode;
  S.learningMode = S.settings.learningMode !== false;
  S.validateMode = S.settings.validateMode !== false;

  // Update mode badges
  const safeBadge = $('btn-safe-mode');
  if (safeBadge) {
    safeBadge.className = 'mode-badge ' + (S.safeMode ? 'safe-on' : 'safe-off');
    safeBadge.title = S.safeMode ? 'Safe Mode ON — click to disable' : 'Safe Mode OFF — click to enable';
  }
  const thinkBadge = $('btn-think-mode');
  if (thinkBadge) thinkBadge.className = 'mode-badge ' + (S.thinkMode ? 'think-on' : 'think-off');

  // Update learn badge
  if (S.learningMode) updateLearnBadge(loadLearning());

  require(['vs/editor/editor.main'], (monaco) => {
    window.monaco = monaco;
    initMonaco();
    loadHistoryData().then(() => {
      wireEvents();
      checkOllama();
      setInterval(checkOllama, 30000);
      showWelcome();
    });
  });
})();
