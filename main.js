const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path  = require('path')
const fs    = require('fs')
const https = require('https')

let mainWindow
let historyFilePath
let modelsPath

// ─── node-llama-cpp state (ESM loaded lazily) ─────────────────────────────────
let llamaLib     = null   // the imported ESM module
let llamaEngine  = null   // getLlama() result
let llamaModel   = null   // loaded model
let loadedModelPath = null

async function getLlamaLib() {
  if (!llamaLib) llamaLib = await import('node-llama-cpp')
  return llamaLib
}

// ─── Available models (first is default) ─────────────────────────────────────
const MODELS = [
  {
    id:       'qwen2.5-coder-1.5b',
    file:     'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    uri:      'hf:Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    label:    'Qwen2.5-Coder 1.5B — fast, code-focused',
    sizeMB:   1100,
  },
  {
    id:       'phi3.5-mini',
    file:     'phi-3.5-mini-instruct-q4_k_m.gguf',
    uri:      'hf:bartowski/Phi-3.5-mini-instruct-GGUF:Phi-3.5-mini-instruct-Q4_K_M.gguf',
    label:    'Phi-3.5 Mini — advanced reasoning, 3.8B',
    sizeMB:   2200,
  },
]
const DEFAULT_MODEL = MODELS[0]

// ─── Model helpers ────────────────────────────────────────────────────────────
function modelFilePath(modelFile) {
  return path.join(modelsPath, modelFile)
}

function modelExists(modelFile) {
  try { return fs.existsSync(modelFilePath(modelFile)) } catch { return false }
}

// ─── Engine init (once, reused) ───────────────────────────────────────────────
async function initEngine() {
  if (llamaEngine) return
  const { getLlama } = await getLlamaLib()
  // auto-detects Metal on Apple Silicon, falls back to CPU
  llamaEngine = await getLlama({ progressLogs: false })
  console.log('[Diphoria] LLaMA engine ready — backend:', llamaEngine.gpu ?? 'cpu')
}

// ─── Load a GGUF model ────────────────────────────────────────────────────────
async function loadModel(modelFile) {
  const mp = modelFilePath(modelFile)
  if (!fs.existsSync(mp)) return false
  if (loadedModelPath === mp && llamaModel) return true  // already loaded

  await initEngine()

  if (llamaModel) {
    try { await llamaModel.dispose() } catch {}
    llamaModel = null
    loadedModelPath = null
  }

  llamaModel = await llamaEngine.loadModel({ modelPath: mp })
  loadedModelPath = mp
  console.log('[Diphoria] Model loaded:', modelFile)
  return true
}

// ─── Download a model from Hugging Face ──────────────────────────────────────
async function downloadModel(wc, modelInfo) {
  const { createModelDownloader } = await getLlamaLib()
  if (!fs.existsSync(modelsPath)) fs.mkdirSync(modelsPath, { recursive: true })

  wc.send('model-download-start', { label: modelInfo.label, sizeMB: modelInfo.sizeMB })
  console.log('[Diphoria] Downloading model:', modelInfo.id)

  const downloader = await createModelDownloader({
    modelUri: modelInfo.uri,
    dirPath:  modelsPath,
    onProgress({ downloadedSize, totalSize }) {
      const pct = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0
      wc.send('model-download-progress', {
        pct,
        downloadedMB: (downloadedSize / 1048576).toFixed(0),
        totalMB:      (totalSize / 1048576).toFixed(0),
      })
    },
  })

  await downloader.download()
  console.log('[Diphoria] Download complete:', modelInfo.file)
  wc.send('model-download-done', { file: modelInfo.file })
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1600,
    height: 980,
    minWidth:  1100,
    minHeight: 680,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      webSecurity:      false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0f',
    show: false,
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.webContents.openDevTools()  // show console for debugging
  })

  const userData  = app.getPath('userData')
  historyFilePath = path.join(userData, 'diphoria-ai-history.json')
  modelsPath      = path.join(userData, 'models')
  if (!fs.existsSync(modelsPath)) fs.mkdirSync(modelsPath, { recursive: true })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

// ─── Model status IPC ─────────────────────────────────────────────────────────
ipcMain.handle('model-status', async () => {
  const exists = modelExists(DEFAULT_MODEL.file)
  const loaded = !!llamaModel && loadedModelPath === modelFilePath(DEFAULT_MODEL.file)
  return { exists, loaded, models: MODELS, defaultModel: DEFAULT_MODEL }
})

ipcMain.handle('model-load', async () => {
  try {
    const ok = await loadModel(DEFAULT_MODEL.file)
    return { ok }
  } catch (e) {
    console.error('[Diphoria] model-load error:', e)
    return { ok: false, error: e.message }
  }
})

ipcMain.on('model-download', async (event, modelId) => {
  const wc    = event.sender
  const model = MODELS.find(m => m.id === modelId) || DEFAULT_MODEL
  try {
    await downloadModel(wc, model)
    const ok = await loadModel(model.file)
    if (ok) wc.send('model-ready')
    else    wc.send('model-download-error', 'Model downloaded but failed to load')
  } catch (e) {
    console.error('[Diphoria] download error:', e)
    wc.send('model-download-error', e.message || 'Download failed')
  }
})

// ─── AI streaming inference ───────────────────────────────────────────────────
const PERF = {
  contextSize: 2048,
  maxTokens:   1024,
  temperature: 0.05,
}

const DEFAULT_SYSTEM = `You are Diphoria AI, a senior HTML/CSS/JS developer. Apply the instruction and return ONLY the complete updated HTML snippet. No markdown fences, no explanations. Mark edits with <!-- DIPHORIA-EDIT: description -->.`

ipcMain.on('ai-stream-start', async (event, { html, instruction, systemPrompt }) => {
  const wc = event.sender

  // Auto-load model if not loaded
  if (!llamaModel) {
    const ok = await loadModel(DEFAULT_MODEL.file)
    if (!ok) {
      wc.send('ai-stream-error', 'AI model not loaded. Please download a model first.')
      return
    }
  }

  const SYSTEM = systemPrompt || DEFAULT_SYSTEM
  wc.send('ai-stream-status', 'thinking')

  let fullText = ''
  try {
    const { LlamaChatSession } = await getLlamaLib()
    const ctxSize = Math.min(llamaModel.trainContextSize || 4096, PERF.contextSize)
    const context = await llamaModel.createContext({ contextSize: ctxSize })

    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt:    SYSTEM,
    })

    await session.prompt(`INSTRUCTION: ${instruction}\n\nHTML:\n${html}`, {
      maxTokens:   PERF.maxTokens,
      temperature: PERF.temperature,
      onTextChunk(text) {
        fullText += text
        wc.send('ai-stream-chunk', text)
      },
    })

    try { await context.dispose() } catch {}

    wc.send('ai-stream-done', { html: fullText, raw: fullText })
  } catch (e) {
    console.error('[Diphoria] inference error:', e)
    wc.send('ai-stream-error', e.message || 'Inference failed')
  }
})

// ─── File IPC ─────────────────────────────────────────────────────────────────
ipcMain.handle('open-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:   'Open HTML File',
    filters: [{ name: 'HTML Files', extensions: ['html', 'htm'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths.length) return { success: false }
  return { success: true, content: fs.readFileSync(filePaths[0], 'utf8'), filePath: filePaths[0] }
})

ipcMain.handle('save-file', async (_e, { html, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title:       'Save HTML File',
    defaultPath: suggestedName || 'output.html',
    filters:     [{ name: 'HTML Files', extensions: ['html', 'htm'] }],
  })
  if (canceled || !filePath) return { success: false }
  fs.writeFileSync(filePath, html, 'utf8')
  return { success: true, filePath }
})

ipcMain.handle('get-history', () => {
  if (!fs.existsSync(historyFilePath)) return []
  try { return JSON.parse(fs.readFileSync(historyFilePath, 'utf8')) } catch { return [] }
})

ipcMain.handle('save-history', (_e, history) => {
  fs.writeFileSync(historyFilePath, JSON.stringify(history, null, 2), 'utf8')
})

ipcMain.handle('show-in-folder', (_e, fp) => shell.showItemInFolder(fp))
