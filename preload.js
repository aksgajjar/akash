const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // ── File ops ──────────────────────────────────────────────────────────────
  openFile:     ()     => ipcRenderer.invoke('open-file'),
  saveFile:     (data) => ipcRenderer.invoke('save-file', data),
  showInFolder: (p)    => ipcRenderer.invoke('show-in-folder', p),

  // ── History ───────────────────────────────────────────────────────────────
  getHistory:   ()     => ipcRenderer.invoke('get-history'),
  saveHistory:  (h)    => ipcRenderer.invoke('save-history', h),

  // ── Model management ──────────────────────────────────────────────────────
  modelStatus:   ()         => ipcRenderer.invoke('model-status'),
  modelLoad:     ()         => ipcRenderer.invoke('model-load'),
  modelDownload: (modelId)  => ipcRenderer.send('model-download', modelId || null),

  // ── AI streaming — fire-and-forget start, then listen via on* ─────────────
  aiStreamStart: (params) => ipcRenderer.send('ai-stream-start', params),

  // ── Streaming listeners (return cleanup fn) ────────────────────────────────
  onStatus: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('ai-stream-status', h); return () => ipcRenderer.removeListener('ai-stream-status', h) },
  onChunk:  (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('ai-stream-chunk',  h); return () => ipcRenderer.removeListener('ai-stream-chunk',  h) },
  onDone:   (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('ai-stream-done',   h); return () => ipcRenderer.removeListener('ai-stream-done',   h) },
  onError:  (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('ai-stream-error',  h); return () => ipcRenderer.removeListener('ai-stream-error',  h) },

  // ── Model download progress listeners ─────────────────────────────────────
  onDownloadStart:    (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('model-download-start',    h); return () => ipcRenderer.removeListener('model-download-start',    h) },
  onDownloadProgress: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('model-download-progress', h); return () => ipcRenderer.removeListener('model-download-progress', h) },
  onDownloadDone:     (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('model-download-done',     h); return () => ipcRenderer.removeListener('model-download-done',     h) },
  onDownloadError:    (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('model-download-error',    h); return () => ipcRenderer.removeListener('model-download-error',    h) },
  onModelReady:       (cb) => { const h = ()      => cb();  ipcRenderer.on('model-ready',            h); return () => ipcRenderer.removeListener('model-ready',            h) },
})
