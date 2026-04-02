const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path  = require('path')
const fs    = require('fs')
const http  = require('http')
const { spawn, execSync } = require('child_process')

let mainWindow
let historyFilePath
let ollamaProcess = null   // track auto-spawned ollama

// ─── Auto-start Ollama ────────────────────────────────────────────────────────
// Called on app launch AND whenever health check fails.
// Tries: 1) brew services  2) direct spawn  3) open Ollama.app
function ensureOllamaRunning() {
  // Check if already reachable first
  const probe = http.get('http://127.0.0.1:11434/api/tags', (res) => {
    if (res.statusCode === 200) return  // already up, do nothing
    startOllama()
  })
  probe.on('error', () => startOllama())
  probe.setTimeout(2000, () => { probe.destroy(); startOllama() })
}

function startOllama() {
  if (ollamaProcess) return  // already spawned by us, don't double-spawn

  // 1. Try brew services (most reliable — runs as background service)
  try {
    execSync('brew services start ollama 2>/dev/null', { timeout: 5000 })
    console.log('[Diphoria] Ollama started via brew services')
    return
  } catch {}

  // 2. Try Ollama.app (GUI install)
  try {
    execSync('open -a Ollama 2>/dev/null', { timeout: 3000 })
    console.log('[Diphoria] Opened Ollama.app')
    return
  } catch {}

  // 3. Direct spawn — find ollama binary
  const candidates = [
    '/usr/local/bin/ollama',
    '/opt/homebrew/bin/ollama',
    '/opt/homebrew/opt/ollama/bin/ollama',
    `${process.env.HOME}/.ollama/ollama`,
  ]
  const binary = candidates.find(p => { try { return fs.existsSync(p) } catch { return false } })

  if (binary) {
    ollamaProcess = spawn(binary, ['serve'], {
      detached: true,
      stdio:    'ignore',
      env:      { ...process.env, OLLAMA_FLASH_ATTENTION: '1' }
    })
    ollamaProcess.unref()
    console.log('[Diphoria] Ollama spawned from:', binary)
  } else {
    console.warn('[Diphoria] Could not find ollama binary — please run: brew install ollama')
  }
}

// On app quit, don't kill Ollama — it may be used elsewhere
app.on('will-quit', () => { ollamaProcess = null })

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

  // Auto-start Ollama immediately when window opens
  ensureOllamaRunning()
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

// ─── Ollama health check ──────────────────────────────────────────────────────
// Always use 127.0.0.1 — "localhost" can resolve to ::1 (IPv6) on some Macs
// Hit /api/tags which returns JSON and confirms Ollama is actually ready
ipcMain.handle('ollama-check', async () => {
  return new Promise((resolve) => {
    console.log('[Diphoria] Checking Ollama at http://127.0.0.1:11434/api/tags')
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      console.log('[Diphoria] Ollama check result:', result)
      resolve(result)
    }

    const req = http.get('http://127.0.0.1:11434/api/tags', (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          const models = (parsed.models || []).map(m => m.name)
          done({ ok: true, models })
        } catch {
          // Got a response but couldn't parse — Ollama is still reachable
          done({ ok: true, models: [] })
        }
      })
      res.on('error', () => done({ ok: false }))
    })

    req.on('error', (err) => {
      console.log('[Diphoria] Ollama offline:', err.message, '— auto-starting...')
      ensureOllamaRunning()   // kick-start automatically
      done({ ok: false })
    })

    // Hard timeout — 3 seconds max
    req.setTimeout(3000, () => {
      console.log('[Diphoria] Ollama check timed out')
      req.destroy()
      done({ ok: false })
    })
  })
})

// ─── Ollama list models — reuses check result, no second request needed ───────
ipcMain.handle('ollama-models', async () => {
  return new Promise((resolve) => {
    let settled = false
    const done = (result) => { if (!settled) { settled = true; resolve(result) } }

    const req = http.get('http://127.0.0.1:11434/api/tags', (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          done({ ok: true, models: (parsed.models || []).map(m => m.name) })
        } catch {
          done({ ok: false, models: [] })
        }
      })
      res.on('error', () => done({ ok: false, models: [] }))
    })
    req.on('error', () => done({ ok: false, models: [] }))
    req.setTimeout(3000, () => { req.destroy(); done({ ok: false, models: [] }) })
  })
})

// ─── Ollama streaming inference ───────────────────────────────────────────────
// Performance defaults — tuned for MacBook Pro 2021 (16GB shared RAM)
const PERF = {
  num_ctx:     2048,   // hard cap — fits in ~1GB RAM, handles snippets not full files
  num_predict: 1024,   // max ~800 tokens output — enough for a section, not a full page
  temperature: 0.05,   // near-deterministic — less creative rambling, faster stop
  timeout_ms:  30000   // 30s hard timeout — fail fast
}

const DEFAULT_SYSTEM = `You are a senior HTML/CSS/JS developer. Apply the instruction and return ONLY the complete updated HTML. No explanations, no markdown fences. Preserve all content not mentioned. Mark edits with <!-- DIPHORIA-EDIT: description -->.`

// Trim oversized HTML before sending — keeps input tokens under ~1200
// Sends: full head + body trimmed to maxChars + closing tags
// Renderer now sends snippets (~2500 chars), but guard here too
function trimHTMLForAI(html, maxChars = 2800) {
  if (html.length <= maxChars) return html
  const headMatch = html.match(/<head[\s\S]*?<\/head>/i)
  const head = headMatch ? headMatch[0] : ''
  const bodyIdx = html.indexOf('<body')
  const body = bodyIdx > -1 ? html.slice(bodyIdx) : html
  const allowedBody = maxChars - head.length
  const trimmedBody = body.slice(0, Math.max(allowedBody, 1500))
  console.log(`[Diphoria] HTML trimmed: ${html.length} → ${head.length + trimmedBody.length} chars`)
  return `${head}\n${trimmedBody}\n<!-- TRIMMED -->\n</body></html>`
}

ipcMain.on('ai-stream-start', async (event, { html, instruction, model, ollamaHost, systemPrompt, imageBase64 }) => {
  const wc   = event.sender
  const host = (ollamaHost && ollamaHost !== 'localhost') ? ollamaHost : '127.0.0.1'
  const port = 11434

  const SYSTEM = systemPrompt || DEFAULT_SYSTEM

  // Trim HTML to keep input tokens manageable
  const trimmedHTML = trimHTMLForAI(html)

  // Build user message — support vision models (llava, etc.) with imageBase64
  const userMessage = { role: 'user', content: `INSTRUCTION: ${instruction}\n\nHTML:\n${trimmedHTML}` }
  if (imageBase64) {
    const b64 = imageBase64.replace(/^data:image\/\w+;base64,/, '')
    userMessage.images = [b64]
  }

  const body = JSON.stringify({
    model,
    stream: true,
    options: {
      temperature: PERF.temperature,
      num_ctx:     PERF.num_ctx,
      num_predict: PERF.num_predict,
    },
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

  req.setTimeout(PERF.timeout_ms, () => {
    req.destroy()
    wc.send('ai-stream-error', `Timed out after ${PERF.timeout_ms / 1000}s. Try a smaller model (llama3.2:3b) or shorter HTML.`)
  })
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
