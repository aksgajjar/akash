const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { callAI } = require('./src/ai-handler')

let mainWindow
let historyFilePath

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0d0d14',
    show: false
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  historyFilePath = path.join(app.getPath('userData'), 'html-ai-editor-history.json')
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ─── IPC Handlers ────────────────────────────────────────────────────────────

ipcMain.handle('apply-changes', async (_event, { html, instruction, apiKey, provider, model }) => {
  try {
    const result = await callAI({ html, instruction, apiKey, provider, model })
    return { success: true, html: result }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('open-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open HTML File',
    filters: [{ name: 'HTML Files', extensions: ['html', 'htm'] }],
    properties: ['openFile']
  })
  if (canceled || filePaths.length === 0) return { success: false }
  const content = fs.readFileSync(filePaths[0], 'utf8')
  return { success: true, content, filePath: filePaths[0] }
})

ipcMain.handle('save-file', async (_event, { html, suggestedName }) => {
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
  try {
    return JSON.parse(fs.readFileSync(historyFilePath, 'utf8'))
  } catch {
    return []
  }
})

ipcMain.handle('save-history', (_event, history) => {
  fs.writeFileSync(historyFilePath, JSON.stringify(history, null, 2), 'utf8')
})

ipcMain.handle('show-item-in-folder', (_event, filePath) => {
  shell.showItemInFolder(filePath)
})
