const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('worklog', {
  loadNote:   key        => ipcRenderer.invoke('load-note', key),
  saveNote:   (key, txt) => ipcRenderer.invoke('save-note', key, txt),
  openFolder: ()         => ipcRenderer.invoke('open-folder'),
  hide:        ()         => ipcRenderer.invoke('hide-window'),
  getActivity: ()         => ipcRenderer.invoke('get-activity'),
})
