const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path  = require('path')
const fs    = require('fs')
const http  = require('http')

let mainWindow
let historyFilePath

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 680,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false          // allow local file:// for Monaco workers
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0f',
    show: false
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())

  historyFilePath = path.join(app.getPath('userData'), 'diphoria-ai-history.json')
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

// ─── Ollama health check ──────────────────────────────────────────────────────
ipcMain.handle('ollama-check', async () => {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:11434/', (res) => {
      resolve({ ok: true, status: res.statusCode })
    })
    req.on('error', () => resolve({ ok: false }))
    req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false }) })
  })
})

// ─── Ollama list models ───────────────────────────────────────────────────────
ipcMain.handle('ollama-models', async () => {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:11434/api/tags', (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          resolve({ ok: true, models: (parsed.models || []).map(m => m.name) })
        } catch {
          resolve({ ok: false, models: [] })
        }
      })
    })
    req.on('error', () => resolve({ ok: false, models: [] }))
  })
})

// ─── Ollama streaming inference ───────────────────────────────────────────────
const DEFAULT_SYSTEM = `You are a world-class senior HTML/CSS/JavaScript developer with 10+ years of experience.
You are an expert in modern web design, responsive layouts, animations, accessibility, and performance.
You understand instructions in BOTH English and Hindi fluently.
Return ONLY the complete updated HTML — no explanations, no markdown fences.`

ipcMain.on('ai-stream-start', async (event, { html, instruction, model, ollamaHost, systemPrompt, imageBase64 }) => {
  const wc   = event.sender
  const host = ollamaHost || 'localhost'
  const port = 11434

  const SYSTEM = systemPrompt || DEFAULT_SYSTEM

  // Build user message — support vision models (llava, etc.) with imageBase64
  const userMessage = { role: 'user', content: `INSTRUCTION: ${instruction}\n\nHTML:\n${html}` }
  if (imageBase64) {
    const b64 = imageBase64.replace(/^data:image\/\w+;base64,/, '')
    userMessage.images = [b64]
  }

  const body = JSON.stringify({
    model,
    stream: true,
    options: { temperature: 0.1, num_ctx: 16384, num_predict: 8192 },
    messages: [
      { role: 'system', content: SYSTEM },
      userMessage
    ]
  })

  wc.send('ai-stream-status', 'thinking')

  const req = http.request(
    { hostname: host, port, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    (res) => {
      let buffer = ''
      let full   = ''

      res.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const parsed = JSON.parse(line)
            const text   = parsed.message?.content || ''
            if (text) { full += text; wc.send('ai-stream-chunk', text) }
            if (parsed.done) {
              const resultHTML = extractHTML(full)
              wc.send('ai-stream-done', { html: resultHTML, raw: full })
            }
          } catch { /* ignore parse errors on incomplete chunks */ }
        }
      })

      res.on('end', () => {
        // fallback if done event didn't fire
        if (full && !full.__done) wc.send('ai-stream-done', { html: extractHTML(full), raw: full })
      })

      res.on('error', (err) => wc.send('ai-stream-error', err.message))
    }
  )

  req.on('error', (err) => {
    const msg = err.code === 'ECONNREFUSED'
      ? 'Ollama is not running. Open Terminal and run: ollama serve'
      : err.message
    wc.send('ai-stream-error', msg)
  })

  req.setTimeout(120000, () => { req.destroy(); wc.send('ai-stream-error', 'Request timed out (2 min)') })
  req.write(body)
  req.end()
})

// ─── HTML extractor ───────────────────────────────────────────────────────────
function extractHTML(text) {
  // Strip markdown fences
  let t = text.replace(/^```(?:html)?\s*/im, '').replace(/\s*```\s*$/m, '').trim()
  // If it starts with <!DOCTYPE or <html, trust it directly
  if (/^<!DOCTYPE\s+html/i.test(t) || /^<html/i.test(t)) return t
  // Try to extract the html block
  const m = t.match(/(<!DOCTYPE\s+html[\s\S]*?<\/html>)/i)
  if (m) return m[1].trim()
  // Fallback
  return t
}

// ─── File IPC ─────────────────────────────────────────────────────────────────
ipcMain.handle('open-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open HTML File',
    filters: [{ name: 'HTML Files', extensions: ['html', 'htm'] }],
    properties: ['openFile']
  })
  if (canceled || !filePaths.length) return { success: false }
  return { success: true, content: fs.readFileSync(filePaths[0], 'utf8'), filePath: filePaths[0] }
})

ipcMain.handle('save-file', async (_e, { html, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save HTML File',
    defaultPath: suggestedName || 'output.html',
    filters: [{ name: 'HTML Files', extensions: ['html', 'htm'] }]
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
