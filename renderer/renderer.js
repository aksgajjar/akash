'use strict';

// ─── Defaults & State ─────────────────────────────────────────────────────────
const STORAGE_KEY = 'html-ai-studio-v2';

const defaults = {
  ollamaHost:    'localhost',
  defaultModel:  'qwen2.5-coder:7b',
  historyLimit:  25,
  provider:      'none',
  apiKey:        '',
  fontSize:      13,
  wordWrap:      'on',
  minimap:       false,
};

const S = {
  settings:         { ...defaults },
  history:          [],
  currentFile:      '',
  lastHtmlBeforeAI: '',
  isStreaming:      false,
  previewTimer:     null,
  streamCleanup:    [],
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
  const input = $('chat-input');
  const modelSel = $('model-select');
  if (!input) return;
  const instruction = input.value.trim();
  if (!instruction) return;

  const editor = window._monacoEditor;
  const html = editor ? editor.getValue() : '';

  const model = modelSel ? modelSel.value : S.settings.defaultModel;
  const ollamaHost = S.settings.ollamaHost || 'localhost';

  input.value = '';
  input.style.height = 'auto';

  appendMessage('user', escapeHtml(instruction));

  S.isStreaming = true;
  setSendBusy(true);

  const aiBubble = appendMessage('ai', 'Thinking...', 'streaming');
  let raw = '';
  let tokenCount = 0;

  S.lastHtmlBeforeAI = html;

  const onStatus = window.api.onStatus((msg) => {
    if (aiBubble) aiBubble.innerHTML = escapeHtml(msg);
  });

  const onChunk = window.api.onChunk((chunk) => {
    raw += chunk;
    tokenCount++;
    if (aiBubble) {
      aiBubble.innerHTML = `Writing... (${tokenCount} tokens)`;
    }
  });

  const onDone = window.api.onDone((finalRaw) => {
    cleanupStream();
    const finalHtml = extractHtml(finalRaw || raw);
    applyHtmlToEditor(finalHtml);
    refreshPreview(finalHtml);
    addHistory(instruction, finalHtml);

    const before = S.lastHtmlBeforeAI.split('\n');
    const after  = finalHtml.split('\n');
    const added   = Math.max(0, after.length - before.length);
    const removed = Math.max(0, before.length - after.length);
    if (aiBubble) {
      aiBubble.classList.remove('streaming');
      aiBubble.innerHTML = `\u2713 Applied \u2014 +${added} lines added, -${removed} removed`;
    }
    S.isStreaming = false;
    setSendBusy(false);
  });

  const onError = window.api.onError((err) => {
    cleanupStream();
    if (aiBubble) {
      aiBubble.classList.remove('streaming');
      aiBubble.classList.add('error');
      aiBubble.innerHTML = `Error: ${escapeHtml(String(err))}`;
    }
    S.isStreaming = false;
    setSendBusy(false);
  });

  S.streamCleanup.push(onStatus, onChunk, onDone, onError);

  try {
    await window.api.aiStreamStart({ html, instruction, model, ollamaHost });
  } catch (e) {
    cleanupStream();
    if (aiBubble) {
      aiBubble.classList.remove('streaming');
      aiBubble.classList.add('error');
      aiBubble.innerHTML = `Error: ${escapeHtml(String(e))}`;
    }
    S.isStreaming = false;
    setSendBusy(false);
  }
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
  require(['vs/editor/editor.main'], (monaco) => {
    window.monaco = monaco;

    const editorContainer = $('monaco-editor') || $('editor-container') || $('editor');
    if (!editorContainer || editorContainer.tagName === 'TEXTAREA') {
      // Fallback: look for a dedicated container div
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

    const editor = monaco.editor.create(target, {
      value:          '',
      language:       'html',
      theme:          'vs-dark',
      fontSize:       S.settings.fontSize,
      wordWrap:       S.settings.wordWrap,
      minimap:        { enabled: !!S.settings.minimap },
      formatOnPaste:  true,
      autoIndent:     'full',
      scrollBeyondLastLine: false,
      tabSize:        2,
      automaticLayout: true,
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

    // Load history and check Ollama after Monaco is ready
    loadHistoryData();
    checkOllama();
    setInterval(checkOllama, 30000);

    wireEvents();
    refreshPreview();
    showWelcome();
  });
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
  initMonaco();
})();
