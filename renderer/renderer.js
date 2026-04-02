'use strict'

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  settings: {
    provider: 'claude',
    modelClaude: 'claude-sonnet-4-6',
    modelOpenAI: 'gpt-4o',
    apiKey: '',
    historyLimit: 20
  },
  history: [],          // [{ id, ts, instruction, html }]
  currentFileName: '',
  isWorking: false,
  previewDebounce: null
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)

const editor          = $('editor')
const preview         = $('preview')
const previewEmpty    = $('preview-empty')
const instruction     = $('instruction')
const btnApply        = $('btn-apply')
const applyBtnText    = $('apply-btn-text')
const applySpinner    = $('apply-spinner')
const applyBtnIcon    = btnApply.querySelector('.apply-btn-icon')
const statusMsg       = $('status-msg')
const fileName        = $('file-name')
const charCount       = $('char-count')
const modelBadge      = $('model-badge')
const historyPanel    = $('history-panel')
const historyList     = $('history-list')
const historyCount    = $('history-count')
const toast           = $('toast')

// Settings modal
const modalBackdrop        = $('modal-backdrop')
const settingProvider      = $('setting-provider')
const settingModelClaude   = $('setting-model-claude')
const settingModelOpenAI   = $('setting-model-openai')
const settingApiKey        = $('setting-apikey')
const settingHistoryLimit  = $('setting-history-limit')
const claudeModelsRow      = $('claude-models-row')
const openaiModelsRow      = $('openai-models-row')
const providerHint         = $('provider-hint')
const saveConfirm          = $('save-confirm')

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  loadSettings()
  applySettingsToUI()
  updateModelBadge()

  state.history = await window.electronAPI.getHistory()
  renderHistory()

  // Keyboard shortcuts
  document.addEventListener('keydown', onKeyDown)

  // Close history panel when clicking outside
  document.addEventListener('click', (e) => {
    if (!historyPanel.classList.contains('hidden') &&
        !$('history-wrap') && !e.target.closest('.history-wrap')) {
      historyPanel.classList.add('hidden')
    }
  })

  // Auto-resize instruction textarea
  instruction.addEventListener('input', () => {
    instruction.style.height = 'auto'
    instruction.style.height = Math.min(instruction.scrollHeight, 80) + 'px'
  })
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function loadSettings() {
  const saved = localStorage.getItem('html-ai-editor-settings')
  if (saved) {
    try { Object.assign(state.settings, JSON.parse(saved)) } catch {}
  }
}

function saveSettings() {
  localStorage.setItem('html-ai-editor-settings', JSON.stringify(state.settings))
}

function applySettingsToUI() {
  settingProvider.value         = state.settings.provider
  settingModelClaude.value      = state.settings.modelClaude
  settingModelOpenAI.value      = state.settings.modelOpenAI
  settingApiKey.value           = state.settings.apiKey
  settingHistoryLimit.value     = String(state.settings.historyLimit)
  updateProviderUI(state.settings.provider)
}

function updateProviderUI(provider) {
  if (provider === 'claude') {
    claudeModelsRow.classList.remove('hidden')
    openaiModelsRow.classList.add('hidden')
    providerHint.textContent = 'Get your key at: console.anthropic.com'
  } else {
    claudeModelsRow.classList.add('hidden')
    openaiModelsRow.classList.remove('hidden')
    providerHint.textContent = 'Get your key at: platform.openai.com/api-keys'
  }
}

function updateModelBadge() {
  const { provider, modelClaude, modelOpenAI } = state.settings
  modelBadge.textContent = provider === 'claude' ? modelClaude : modelOpenAI
}

// ─── Preview ─────────────────────────────────────────────────────────────────
function refreshPreview(html) {
  const content = html !== undefined ? html : editor.value
  if (!content.trim()) {
    previewEmpty.classList.remove('hidden')
    preview.srcdoc = ''
    return
  }
  previewEmpty.classList.add('hidden')
  preview.srcdoc = content
}

function schedulePreviewRefresh() {
  if (!$('toggle-autorefresh').checked) return
  clearTimeout(state.previewDebounce)
  state.previewDebounce = setTimeout(() => refreshPreview(), 600)
}

// ─── Editor helpers ───────────────────────────────────────────────────────────
function updateCharCount() {
  const n = editor.value.length
  charCount.textContent = n.toLocaleString() + ' chars'
}

function setEditorHTML(html) {
  editor.value = html
  updateCharCount()
  refreshPreview(html)
}

// Basic HTML formatter — indent tags
function formatHTML(html) {
  let indent = 0
  const tab = '  '
  return html
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map((line) => {
      line = line.trim()
      if (!line) return ''
      if (line.match(/^<\/\w/)) indent = Math.max(0, indent - 1)
      const result = tab.repeat(indent) + line
      if (line.match(/^<\w[^/]*[^/]>$/) && !line.match(/^<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)/i)) {
        indent++
      }
      return result
    })
    .filter(Boolean)
    .join('\n')
}

// ─── History ──────────────────────────────────────────────────────────────────
function addToHistory(instruction, html) {
  const entry = {
    id: Date.now(),
    ts: new Date().toISOString(),
    instruction: instruction.slice(0, 80),
    html
  }
  state.history.unshift(entry)
  if (state.history.length > state.settings.historyLimit) {
    state.history = state.history.slice(0, state.settings.historyLimit)
  }
  window.electronAPI.saveHistory(state.history)
  renderHistory()
}

function renderHistory() {
  const count = state.history.length
  historyCount.textContent = count > 0 ? String(count) : ''

  if (count === 0) {
    historyList.innerHTML = '<div class="history-empty">No versions saved yet</div>'
    return
  }

  historyList.innerHTML = state.history.map((item) => {
    const date = new Date(item.ts)
    const time = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const size = (item.html.length / 1024).toFixed(1) + ' KB'
    return `
      <div class="history-item" data-id="${item.id}">
        <div class="history-item-instruction">${escapeHtml(item.instruction)}</div>
        <div class="history-item-meta">${time} · ${size}</div>
      </div>
    `
  }).join('')

  historyList.querySelectorAll('.history-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset.id)
      const entry = state.history.find((h) => h.id === id)
      if (entry) {
        setEditorHTML(entry.html)
        historyPanel.classList.add('hidden')
        showToast('Restored version', 'success')
      }
    })
  })
}

// ─── Apply AI changes ─────────────────────────────────────────────────────────
async function applyChanges() {
  if (state.isWorking) return

  const html = editor.value.trim()
  const inst = instruction.value.trim()

  if (!html) { showToast('Paste some HTML first.', 'error'); return }
  if (!inst) { showToast('Enter an instruction.', 'error'); return }
  if (!state.settings.apiKey) {
    showToast('No API key — open Settings (⚙) to add one.', 'error')
    return
  }

  // Save current version before modifying
  addToHistory('(before: ' + inst + ')', editor.value)

  state.isWorking = true
  setBusy(true)
  setStatus('Sending to AI...', 'working')

  const { provider, modelClaude, modelOpenAI } = state.settings
  const model = provider === 'claude' ? modelClaude : modelOpenAI

  const result = await window.electronAPI.applyChanges({
    html: editor.value,
    instruction: inst,
    apiKey: state.settings.apiKey,
    provider,
    model
  })

  state.isWorking = false
  setBusy(false)

  if (result.success) {
    addToHistory(inst, result.html)
    setEditorHTML(result.html)
    setStatus('Done ✓', 'success')
    showToast('Changes applied!', 'success')
    instruction.value = ''
    instruction.style.height = 'auto'
  } else {
    setStatus('Error', 'error')
    showToast(result.error || 'Unknown error', 'error')
  }

  setTimeout(() => setStatus(''), 4000)
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setBusy(busy) {
  btnApply.disabled = busy
  applyBtnText.classList.toggle('hidden', busy)
  applyBtnIcon.classList.toggle('hidden', busy)
  applySpinner.classList.toggle('hidden', !busy)
}

function setStatus(msg, type = '') {
  statusMsg.textContent = msg
  statusMsg.className = 'status-msg' + (type ? ' ' + type : '')
}

let toastTimer = null
function showToast(msg, type = '') {
  toast.textContent = msg
  toast.className = 'toast' + (type ? ' toast-' + type : '')
  toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500)
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── File operations ──────────────────────────────────────────────────────────
async function openFile() {
  const result = await window.electronAPI.openFile()
  if (!result.success) return
  setEditorHTML(result.content)
  const parts = result.filePath.split(/[\\/]/)
  state.currentFileName = parts[parts.length - 1]
  fileName.textContent = state.currentFileName
  showToast('Opened: ' + state.currentFileName, 'success')
}

async function saveFile() {
  const html = editor.value
  if (!html.trim()) { showToast('Nothing to save.', 'error'); return }
  const result = await window.electronAPI.saveFile({
    html,
    suggestedName: state.currentFileName || 'output.html'
  })
  if (result.success) {
    const parts = result.filePath.split(/[\\/]/)
    state.currentFileName = parts[parts.length - 1]
    fileName.textContent = state.currentFileName
    showToast('Saved: ' + state.currentFileName, 'success')
  }
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
function onKeyDown(e) {
  const mod = e.metaKey || e.ctrlKey

  if (mod && e.key === 'o') { e.preventDefault(); openFile(); return }
  if (mod && e.key === 's') { e.preventDefault(); saveFile(); return }
  if (mod && e.key === 'Enter') { e.preventDefault(); applyChanges(); return }
  if (e.key === 'Escape') {
    modalBackdrop.classList.add('hidden')
    historyPanel.classList.add('hidden')
  }

  // Tab key in editor inserts spaces
  if (e.key === 'Tab' && document.activeElement === editor) {
    e.preventDefault()
    const start = editor.selectionStart
    const end = editor.selectionEnd
    editor.value = editor.value.slice(0, start) + '  ' + editor.value.slice(end)
    editor.selectionStart = editor.selectionEnd = start + 2
  }
}

// ─── Resize handle ────────────────────────────────────────────────────────────
function initResize() {
  const handle  = $('resize-handle')
  const edPanel = $('editor-panel')
  const workspace = document.querySelector('.workspace')
  let dragging = false

  handle.addEventListener('mousedown', (e) => {
    dragging = true
    handle.classList.add('dragging')
    e.preventDefault()
  })

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const rect = workspace.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width * 100
    const clamped = Math.max(20, Math.min(80, ratio))
    edPanel.style.flex = `0 0 ${clamped}%`
  })

  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false
      handle.classList.remove('dragging')
    }
  })
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
$('btn-open').addEventListener('click', openFile)
$('btn-save').addEventListener('click', saveFile)
$('btn-apply').addEventListener('click', applyChanges)

$('btn-refresh').addEventListener('click', () => refreshPreview())

$('btn-clear').addEventListener('click', () => {
  if (!editor.value.trim() || confirm('Clear the editor?')) {
    editor.value = ''
    updateCharCount()
    refreshPreview()
    state.currentFileName = ''
    fileName.textContent = ''
  }
})

$('btn-format').addEventListener('click', () => {
  if (!editor.value.trim()) return
  try {
    const formatted = formatHTML(editor.value)
    editor.value = formatted
    updateCharCount()
    showToast('Code formatted', 'success')
  } catch {
    showToast('Could not format', 'error')
  }
})

$('btn-history').addEventListener('click', (e) => {
  e.stopPropagation()
  historyPanel.classList.toggle('hidden')
})

$('btn-clear-history').addEventListener('click', (e) => {
  e.stopPropagation()
  if (confirm('Clear all version history?')) {
    state.history = []
    window.electronAPI.saveHistory([])
    renderHistory()
    historyPanel.classList.add('hidden')
    showToast('History cleared')
  }
})

editor.addEventListener('input', () => {
  updateCharCount()
  schedulePreviewRefresh()
})

$('toggle-autorefresh').addEventListener('change', (e) => {
  if (e.target.checked) refreshPreview()
})

// Settings modal
$('btn-settings').addEventListener('click', () => {
  applySettingsToUI()
  saveConfirm.classList.add('hidden')
  modalBackdrop.classList.remove('hidden')
})

$('modal-close').addEventListener('click', () => modalBackdrop.classList.add('hidden'))

modalBackdrop.addEventListener('click', (e) => {
  if (e.target === modalBackdrop) modalBackdrop.classList.add('hidden')
})

settingProvider.addEventListener('change', () => {
  updateProviderUI(settingProvider.value)
})

$('apikey-toggle').addEventListener('click', () => {
  const isPassword = settingApiKey.type === 'password'
  settingApiKey.type = isPassword ? 'text' : 'password'
  $('apikey-toggle').title = isPassword ? 'Hide key' : 'Show key'
})

$('settings-save').addEventListener('click', () => {
  state.settings.provider      = settingProvider.value
  state.settings.modelClaude   = settingModelClaude.value
  state.settings.modelOpenAI   = settingModelOpenAI.value
  state.settings.apiKey        = settingApiKey.value.trim()
  state.settings.historyLimit  = Number(settingHistoryLimit.value)
  saveSettings()
  updateModelBadge()
  saveConfirm.classList.remove('hidden')
  setTimeout(() => saveConfirm.classList.add('hidden'), 2000)
})

// Instruction: submit on Enter (not Shift+Enter)
instruction.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    applyChanges()
  }
})

// ─── Boot ─────────────────────────────────────────────────────────────────────
initResize()
init()
