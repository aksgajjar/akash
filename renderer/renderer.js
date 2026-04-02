'use strict';

// ─── Defaults & State ─────────────────────────────────────────────────────────
const STORAGE_KEY = 'diphoria-ai-v1';

const defaults = {
  historyLimit:  25,
  provider:      'none',
  apiKey:        '',
  fontSize:      13,
  wordWrap:      'on',
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
    's-history-limit': 'historyLimit',
    's-provider':      'provider',
    's-apikey':        'apiKey',
    's-font-size':     'fontSize',
    's-word-wrap':     'wordWrap',
  };
  for (const [id, key] of Object.entries(map)) {
    const el = $(id);
    if (el) el.value = String(S.settings[key]);
  }
}

function readSettingsFromForm() {
  S.settings.historyLimit = $('s-history-limit') ? parseInt($('s-history-limit').value, 10) || 25 : 25;
  S.settings.provider     = $('s-provider')      ? $('s-provider').value              : S.settings.provider;
  S.settings.apiKey       = $('s-apikey')        ? $('s-apikey').value.trim()          : S.settings.apiKey;
  S.settings.fontSize     = $('s-font-size')     ? parseInt($('s-font-size').value, 10) || 13 : 13;
  S.settings.wordWrap     = $('s-word-wrap')     ? $('s-word-wrap').value              : S.settings.wordWrap;
}

function applySettingsToCM(editor) {
  if (!editor) return;
  const fs = S.settings.fontSize || 13;
  editor.getWrapperElement().style.fontSize = fs + 'px';
  editor.setOption('lineWrapping', S.settings.wordWrap !== 'off');
  editor.refresh();
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

// Compact system prompt — keeps token count low for performance
// Detailed rules replaced with concise equivalents (~150 tokens vs ~500 before)
function buildSystemPrompt(instruction, html) {
  const safe  = S.safeMode  ? 'SAFE MODE: Modify ONLY the mentioned section. Preserve all IDs, classes, structure. Mark edits: <!-- DIPHORIA-EDIT: what -->.' : 'Mark edits: <!-- DIPHORIA-EDIT: what -->.'
  const think = S.thinkMode ? ' Add <!-- THINK: section=X approach=Y --> before changes.' : ''

  // Detect sections — single line, low token cost
  const sections = detectSections(html)
  const ctx = sections.length ? ` Sections found: ${sections.join(', ')}.` : ''

  // Only include top-3 learned instructions to limit token overhead
  const learnData = S.learningMode ? loadLearning() : null
  const prefs = (learnData && learnData.instructions.length)
    ? ` User style prefs: ${JSON.stringify(learnData.prefs || {})}.`
    : ''

  const img = S.pendingImageBase64 ? ' A reference image is attached — use its colors/layout as inspiration.' : ''

  return `You are Diphoria AI, a senior HTML/CSS/JS developer. Apply the instruction and return ONLY the complete updated HTML. No markdown, no explanations.${ctx} ${safe}${think}${prefs}${img}`
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

// ─── Quick Edit Engine — instant CSS changes, zero AI calls ──────────────────
// Maps natural language → CSS property:value, applied directly to the HTML string.
// Runs in <50ms. Only falls through to AI if pattern not matched.

const COLOR_MAP = {
  'dark forest':'#0d1f0d','forest green':'#1a4a1a','forest':'#1a3a1a',
  'dark green':'#0f2a0f','navy blue':'#001433','navy':'#001f3f',
  'midnight blue':'#191970','midnight':'#0d0d2b','dark blue':'#0a0a2e',
  'charcoal':'#1e1e1e','slate':'#1e293b','dark gray':'#1a1a1a',
  'dark grey':'#1a1a1a','dark':'#0f0f1a','pitch black':'#000',
  'black':'#000','white':'#fff','cream':'#fffdf4','off white':'#f5f5f0',
  'light':'#f8f9fa','light gray':'#e9ecef','red':'#c0392b',
  'dark red':'#7b1a1a','blue':'#2980b9','sky blue':'#3498db',
  'purple':'#6c3483','violet':'#5b21b6','indigo':'#3730a3',
  'green':'#1e8449','teal':'#0d7377','cyan':'#0891b2',
  'orange':'#d35400','amber':'#d97706','yellow':'#b7950b',
  'pink':'#c0186c','rose':'#9f1239','brown':'#6b3a2a',
  'gray':'#4a4a4a','grey':'#4a4a4a',
};

function resolveColor(text) {
  const lower = text.toLowerCase();
  const hex = lower.match(/#[0-9a-f]{3,6}/i);
  if (hex) return hex[0];
  const rgb = lower.match(/rgb\([^)]+\)/i);
  if (rgb) return rgb[0];
  // Try longest match first
  const sorted = Object.keys(COLOR_MAP).sort((a,b) => b.length - a.length);
  for (const name of sorted) {
    if (lower.includes(name)) return COLOR_MAP[name];
  }
  return null;
}

// Returns { type, value } if quick-editable, else null
function classifyInstruction(instruction) {
  const t = instruction.toLowerCase();
  if (/background|bg color|bg-color/.test(t)) {
    const c = resolveColor(t);
    if (c) return { type:'background', value:c };
  }
  if (/text color|font color|color of text/.test(t)) {
    const c = resolveColor(t);
    if (c) return { type:'color', value:c };
  }
  if (/font.?size|text.?size|make.*(?:bigger|smaller|larger)/.test(t)) {
    const size = t.match(/(\d+)\s*px/) || t.match(/(bigger|larger)/) || t.match(/(smaller)/);
    if (size) return { type:'fontSize', value: size[1] === 'smaller' ? '13px' : (size[1] === 'bigger'||size[1] === 'larger') ? '17px' : size[1]+'px' };
  }
  return null;
}

// Apply CSS change directly to the HTML string — no AI needed
function applyQuickCSS(html, type, value) {
  let updated = html;

  if (type === 'background') {
    // Try updating body { background or background-color in <style>
    updated = updated.replace(/(body\s*\{[^}]*?)(background(?:-color)?)\s*:\s*[^;]+;/s,
      (m, pre, prop) => `${pre}${prop}:${value};`);
    if (updated === html) {
      // Try CSS variable --bg
      updated = updated.replace(/(--bg\s*:\s*)[^;]+;/, `$1${value};`);
    }
    if (updated === html) {
      // Inject into existing <style> body rule or add new style tag
      if (/<style[^>]*>/.test(updated)) {
        updated = updated.replace(/(<style[^>]*>)/, `$1\nbody{background-color:${value}!important}`);
      } else {
        updated = updated.replace(/<\/head>/i,
          `<style>body{background-color:${value}!important}</style>\n</head>`);
      }
    }
  }

  if (type === 'color') {
    updated = updated.replace(/(body\s*\{[^}]*?)(color)\s*:\s*[^;]+;/s,
      (m, pre) => `${pre}color:${value};`);
    if (updated === html) {
      updated = updated.replace(/(<style[^>]*>)/, `$1\nbody{color:${value}!important}`);
    }
  }

  if (type === 'fontSize') {
    updated = updated.replace(/(body\s*\{[^}]*?)(font-size)\s*:\s*[^;]+;/s,
      (m, pre) => `${pre}font-size:${value};`);
    if (updated === html) {
      updated = updated.replace(/(<style[^>]*>)/, `$1\nbody{font-size:${value}!important}`);
    }
  }

  return updated;
}

// ─── Partial Edit — extract section, get snippet from AI, splice back ─────────
function extractSectionForAI(html, instruction) {
  const t = instruction.toLowerCase();

  // For pure CSS/style changes → only send the <style> block
  if (/background|color|font|spacing|padding|margin|border|shadow|animation|transition|hover/.test(t)) {
    const styleMatch = html.match(/<style[^>]*>[\s\S]*?<\/style>/i);
    if (styleMatch && styleMatch[0].length < 3000) {
      return { snippet: styleMatch[0], mode: 'style-only' };
    }
  }

  // For section-targeted edits → extract matching tag
  const sectionHints = {
    'header|nav|logo|navigation': 'header',
    'footer': 'footer',
    'button|btn': 'button',
    'hero|banner': 'section',
    'card|widget|box': 'div',
    'table': 'table',
    'form|input': 'form',
  };
  for (const [pattern, tag] of Object.entries(sectionHints)) {
    if (new RegExp(pattern).test(t)) {
      const tagMatch = html.match(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'i'));
      if (tagMatch && tagMatch[0].length < 3000) {
        return { snippet: tagMatch[0], mode: tag };
      }
    }
  }

  // Fallback: send trimmed body (max 2500 chars)
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    const trimmed = bodyMatch[0].slice(0, 2500);
    return { snippet: trimmed, mode: 'body' };
  }

  // Last resort: first 2500 chars
  return { snippet: html.slice(0, 2500), mode: 'raw' };
}

// Splice AI snippet back into the original full HTML
function spliceSnippetBack(fullHtml, snippet, mode) {
  // Full rewrite mode or AI returned a complete document — use directly
  if (mode === 'full' || /<!DOCTYPE|<html/i.test(snippet)) return snippet;

  if (mode === 'style-only') {
    const replaced = fullHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/i, snippet);
    return replaced !== fullHtml ? replaced : fullHtml;
  }
  if (mode === 'header') {
    const replaced = fullHtml.replace(/<header[\s\S]*?<\/header>/i, snippet);
    return replaced !== fullHtml ? replaced : fullHtml;
  }
  if (mode === 'footer') {
    const replaced = fullHtml.replace(/<footer[\s\S]*?<\/footer>/i, snippet);
    return replaced !== fullHtml ? replaced : fullHtml;
  }
  if (mode === 'body') {
    const replaced = fullHtml.replace(/<body[^>]*>[\s\S]*?<\/body>/i, snippet);
    return replaced !== fullHtml ? replaced : fullHtml;
  }
  // For other modes, try to find and replace the matching block
  return fullHtml;
}


// ─── AI Engine status (node-llama-cpp) ───────────────────────────────────────
async function checkModelStatus() {
  const dot   = $('status-dot');
  const label = $('status-label');
  try {
    const s = await window.api.modelStatus();
    const ok = s && s.loaded;
    if (dot)   { dot.classList.toggle('ok', ok); dot.classList.toggle('err', !ok); }
    if (label) label.textContent = ok ? 'AI Ready' : (s && s.exists ? 'Loading…' : 'No model');
  } catch (e) {
    if (dot)   { dot.classList.remove('ok'); dot.classList.add('err'); }
    if (label) label.textContent = 'AI error';
  }
}

// ─── First-run model setup overlay ───────────────────────────────────────────
async function initModelSetup() {
  const overlay = $('model-setup-overlay');
  if (!overlay) return;

  const s = await window.api.modelStatus();
  if (s && s.loaded) return;  // model already ready

  // Populate model options
  if (s && s.models) {
    const container = $('model-options');
    if (container) {
      container.innerHTML = s.models.map((m, i) =>
        `<label class="model-option ${i === 0 ? 'selected' : ''}">
          <input type="radio" name="model-choice" value="${m.id}" ${i === 0 ? 'checked' : ''}>
          <span class="model-option-label">${m.label}</span>
          <span class="model-option-size">~${(m.sizeMB / 1000).toFixed(1)} GB</span>
        </label>`
      ).join('');
    }
  }

  if (s && s.exists) {
    // Model file present but not loaded — load it
    setStatusLabel('Loading model…', false);
    const r = await window.api.modelLoad();
    if (r && r.ok) { checkModelStatus(); return; }
  }

  // Need download
  overlay.classList.remove('hidden');

  const cleanupDl = setupDownloadListeners(overlay);

  const startBtn = $('btn-start-download');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      const chosen = overlay.querySelector('input[name="model-choice"]:checked');
      const modelId = chosen ? chosen.value : null;
      window.api.modelDownload(modelId);
      $('model-choose-step').classList.add('hidden');
      $('model-progress-step').classList.remove('hidden');
    }, { once: true });
  }

  const retryBtn = $('btn-retry-download');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      $('model-error-step').classList.add('hidden');
      $('model-choose-step').classList.remove('hidden');
    });
  }
}

function setupDownloadListeners(overlay) {
  const c1 = window.api.onDownloadStart((d) => {
    const h = $('dl-model-name'); if (h) h.textContent = 'Downloading: ' + (d.label || 'model');
    const hint = $('dl-size-hint'); if (hint) hint.textContent = `~${(d.sizeMB/1000).toFixed(1)} GB — one-time download`;
  });
  const c2 = window.api.onDownloadProgress((d) => {
    const bar = $('dl-bar'); if (bar) bar.style.width = d.pct + '%';
    const pct = $('dl-pct'); if (pct) pct.textContent = d.pct + '%';
    const bytes = $('dl-bytes'); if (bytes) bytes.textContent = `${d.downloadedMB} / ${d.totalMB} MB`;
  });
  const c3 = window.api.onDownloadError((err) => {
    $('model-progress-step').classList.add('hidden');
    $('model-error-step').classList.remove('hidden');
    const msg = $('model-error-msg'); if (msg) msg.textContent = err;
  });
  const c4 = window.api.onModelReady(() => {
    overlay.classList.add('hidden');
    checkModelStatus();
    showToast('AI model ready', 'ok');
    [c1, c2, c3, c4].forEach(fn => { try { fn(); } catch {} });
  });
  return () => [c1, c2, c3, c4].forEach(fn => { try { fn(); } catch {} });
}

function setStatusLabel(text, ok) {
  const dot = $('status-dot'); const label = $('status-label');
  if (dot) { dot.classList.toggle('ok', ok); dot.classList.toggle('err', !ok); }
  if (label) label.textContent = text;
}

// ─── Preview ──────────────────────────────────────────────────────────────────
function refreshPreview() {
  const html    = window._cmEditor ? window._cmEditor.getValue() : '';
  const iframe  = $('preview');
  const placeholder = $('pv-placeholder');
  if (!html.trim()) {
    if (placeholder) placeholder.style.display = '';
    if (iframe) iframe.srcdoc = '';
    return;
  }
  if (placeholder) placeholder.style.display = 'none';
  if (iframe) {
    iframe.srcdoc = html;
    console.log('Preview refreshed');
    try { iframe.contentWindow.location.reload(); } catch {}
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
  if (!input) return;
  const instruction = input.value.trim();
  if (!instruction) return;

  const editor = window._cmEditor;
  const html = editor ? editor.getValue() : '';
  if (!html.trim()) { showToast('Paste some HTML first', 'err'); return; }

  if (S.learningMode) addToLearning(instruction);
  autoBackup(html, instruction);
  input.value = '';
  input.style.height = 'auto';

  appendMessage('user', `<div class="msg-bubble">${escapeHtml(instruction)}</div>`);

  // ── ROUTE 1: Quick Edit — instant, no AI, <50ms ───────────────────────────
  const quick = classifyInstruction(instruction);
  if (quick && !S.pendingImageBase64) {
    const updated = applyQuickCSS(html, quick.type, quick.value);
    if (updated !== html) {
      addHistory(instruction, updated);
      applyHtmlToEditor(updated);
      refreshPreview();
      appendMessage('ai', `<div class="msg-bubble">⚡ Quick Edit applied — ${quick.type}: <code>${quick.value}</code> (no AI needed)</div>`);
      showToast('Applied instantly', 'ok');
      return;
    }
  }

  // ── ROUTE 2: AI Full Rewrite ──────────────────────────────────────────────
  if (S.isStreaming) return;
  S.isStreaming = true;
  setSendBusy(true);
  S.lastHtmlBeforeAI = html;

  const aiBubble = appendMessage('ai', `<div class="msg-bubble streaming">Sending to AI...</div>`, 'streaming');

  // Always send full HTML — allows layout changes and full document rewrites
  const mode = 'full';

  const systemPrompt = buildSystemPrompt(instruction, html);

  const userContent = `INSTRUCTION: ${instruction}\n\nHTML:\n${html}`;

  let raw = '';
  let tokenCount = 0;
  // 10-second warning timer
  const warnTimer = setTimeout(() => {
    if (S.isStreaming && aiBubble) {
      aiBubble.querySelector('.msg-bubble').textContent = 'Still working... (10s) — try llama3.2:3b for speed';
    }
  }, 10000);

  const onStatus = window.api.onStatus(() => {});

  const onChunk = window.api.onChunk((chunk) => {
    raw += chunk;
    tokenCount++;
    if (aiBubble) {
      aiBubble.querySelector('.msg-bubble').textContent = `Writing... (${tokenCount} tokens)`;
    }
  });

  const onDone = window.api.onDone((result) => {
    clearTimeout(warnTimer);
    cleanupStream();
    S.isStreaming = false;
    setSendBusy(false);

    const rawResponse = (result && result.html) ? result.html : raw;
    // Full rewrite: use AI response directly; splice only if AI returned a partial snippet
    const merged = spliceSnippetBack(html, rawResponse.trim(), mode);
    // Validate merged result
    if (S.validateMode) {
      const v = validateHTML(merged);
      if (!v.valid) {
        if (aiBubble) {
          aiBubble.classList.remove('streaming');
          const b = aiBubble.querySelector('.msg-bubble');
          if (b) { b.className = 'msg-bubble validation-err'; b.innerHTML = `⚠ Rejected: ${escapeHtml(v.error)}`; }
        }
        showToast('AI output invalid — not applied', 'err');
        return;
      }
    }

    addHistory(instruction, merged);
    applyHtmlToEditor(merged);
    refreshPreview();

    if (aiBubble) {
      aiBubble.classList.remove('streaming');
      aiBubble.querySelector('.msg-bubble').innerHTML =
        `✓ Applied via AI (${tokenCount} tokens)`;
    }
    showToast('Changes applied', 'ok');
  });

  const onError = window.api.onError((err) => {
    clearTimeout(warnTimer);
    cleanupStream();
    S.isStreaming = false;
    setSendBusy(false);
    if (aiBubble) {
      aiBubble.classList.remove('streaming');
      const b = aiBubble.querySelector('.msg-bubble');
      if (b) { b.className = 'msg-bubble validation-err'; b.textContent = '✗ ' + err; }
    }
    showToast(err, 'err');
  });

  S.streamCleanup = [onStatus, onChunk, onDone, onError];

  // Send snippet (not full HTML) to AI
  window.api.aiStreamStart({
    html: snippet,      // only the relevant section
    instruction,
    systemPrompt,       // compact snippet-only prompt
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
  const editor = window._cmEditor;
  if (!editor) return;
  editor.setValue(html);
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
      refreshPreview();
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
    refreshPreview();
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
  const editor = window._cmEditor;
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
  const editor = window._cmEditor;
  if (!editor) return;
  // Simple format: normalize 2-space indentation using DOMParser + serialization
  const html = editor.getValue();
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    // Use innerHTML indentation as a basic beautifier
    const formatted = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    editor.setValue(formatted);
  } catch { /* keep as-is if parse fails */ }
}

function copyHTML() {
  const editor = window._cmEditor;
  const html = editor ? editor.getValue() : '';
  if (!html) { showToast('Nothing to copy', 'err'); return; }
  navigator.clipboard.writeText(html).then(
    () => showToast('Copied to clipboard', 'ok'),
    () => showToast('Copy failed', 'err')
  );
}

function clearEditor() {
  const editor = window._cmEditor;
  if (!editor) return;
  applyHtmlToEditor('');
  refreshPreview();
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

// ─── Diff — simple char-count delta (no Monaco diff editor needed) ───────────
function toggleDiff() {
  const before = S.lastHtmlBeforeAI || '';
  const after  = window._cmEditor ? window._cmEditor.getValue() : '';
  if (!before) { showToast('No pre-edit snapshot yet', ''); return; }
  const delta = after.length - before.length;
  const sign  = delta >= 0 ? '+' : '';
  showToast(`Last edit: ${sign}${delta} chars (${before.length} → ${after.length})`, delta >= 0 ? 'ok' : '');
}

// ─── CodeMirror 5 Initialization ─────────────────────────────────────────────
function initCodeMirror() {
  const container = $('cm-editor');
  if (!container) { console.error('[Diphoria] #cm-editor not found — check index.html'); return; }

  let editor;
  try {
    editor = CodeMirror(container, {
      value:          '',
      mode:           'htmlmixed',
      theme:          'dracula',
      lineNumbers:    true,
      lineWrapping:   S.settings.wordWrap !== 'off',
      tabSize:        2,
      indentWithTabs: false,
      autoCloseTags:  true,
      matchBrackets:  true,
      autofocus:      false,
    });
  } catch (e) {
    console.error('[Diphoria] CodeMirror init failed:', e);
    return;
  }

  // Apply font size
  const fs = S.settings.fontSize || 13;
  container.style.fontSize = fs + 'px';

  window._cmEditor = editor;

  // Force correct height after first layout paint
  requestAnimationFrame(() => { editor.refresh(); });

  // Cursor → line-info
  editor.on('cursorActivity', () => {
    const cur  = editor.getCursor();
    const info = $('line-info');
    if (info) info.textContent = `Ln ${cur.line + 1}, Col ${cur.ch + 1}`;
  });

  // Content change → debounced preview + char count
  editor.on('change', () => {
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
      applySettingsToCM(editor);
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
document.addEventListener('DOMContentLoaded', function boot() {
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

  // CodeMirror is loaded synchronously via <script> tags — no AMD loader needed
  initCodeMirror();
  loadHistoryData().then(() => {
    wireEvents();
    initModelSetup();          // show download overlay if model missing
    checkModelStatus();
    setInterval(checkModelStatus, 30000);
    showWelcome();
  });
});
