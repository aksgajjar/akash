const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  applyChanges:      (data)    => ipcRenderer.invoke('apply-changes', data),
  openFile:          ()        => ipcRenderer.invoke('open-file'),
  saveFile:          (data)    => ipcRenderer.invoke('save-file', data),
  getHistory:        ()        => ipcRenderer.invoke('get-history'),
  saveHistory:       (history) => ipcRenderer.invoke('save-history', history),
  showItemInFolder:  (path)    => ipcRenderer.invoke('show-item-in-folder', path)
})
