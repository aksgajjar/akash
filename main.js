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
    uri:      'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    label:    'Qwen2.5-Coder 1.5B — fast, code-focused',
    sizeMB:   1100,
  },
  {
    id:       'phi3.5-mini',
    file:     'phi-3.5-mini-instruct-q4_k_m.gguf',
    uri:      'https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf',
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
function httpsGetFollow(url, onResponse) {
  https.get(url, { headers: { 'User-Agent': 'Diphoria-AI/3.0' } }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      httpsGetFollow(res.headers.location, onResponse)
    } else {
      onResponse(res)
    }
  }).on('error', onResponse)
}

async function downloadModel(wc, modelInfo) {
  if (!fs.existsSync(modelsPath)) fs.mkdirSync(modelsPath, { recursive: true })

  wc.send('model-download-start', { label: modelInfo.label, sizeMB: modelInfo.sizeMB })
  console.log('[Diphoria] Downloading model:', modelInfo.id, 'from', modelInfo.uri)

  const destPath = modelFilePath(modelInfo.file)

  await new Promise((resolve, reject) => {
    httpsGetFollow(modelInfo.uri, res => {
      if (res instanceof Error) {
        console.error('[Diphoria] Download error:', res)
        return reject(res)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${modelInfo.uri}`))
      }

      const totalSize = parseInt(res.headers['content-length'] || '0', 10)
      let downloadedSize = 0

      const fileStream = fs.createWriteStream(destPath)
      res.on('data', chunk => {
        downloadedSize += chunk.length
        const pct = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0
        wc.send('model-download-progress', {
          pct,
          downloadedMB: (downloadedSize / 1048576).toFixed(0),
          totalMB:      (totalSize  / 1048576).toFixed(0),
        })
      })
      res.pipe(fileStream)
      fileStream.on('finish', () => { fileStream.close(); resolve() })
      fileStream.on('error', err => {
        console.error('[Diphoria] File write error:', err)
        fs.unlink(destPath, () => {})
        reject(err)
      })
      res.on('error', err => {
        console.error('[Diphoria] Download stream error:', err)
        fs.unlink(destPath, () => {})
        reject(err)
      })
    })
  })

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

  // Step 1: download file (pure https, no node-llama-cpp)
  try {
    await downloadModel(wc, model)
  } catch (e) {
    console.error('[Diphoria] download error:', e)
    wc.send('model-download-error', e.message || 'Download failed')
    return
  }

  // Step 2: load model into llama engine (separate error path)
  try {
    const ok = await loadModel(model.file)
    if (ok) wc.send('model-ready')
    else    wc.send('model-download-error', 'Model file saved but could not be loaded into engine')
  } catch (e) {
    console.error('[Diphoria] model load error:', e)
    // Download succeeded — model file is on disk; engine load failed
    // Send model-ready so user can at least see the app; inference will error gracefully
    wc.send('model-download-error', 'Downloaded OK but engine load failed: ' + (e.message || 'unknown error'))
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
