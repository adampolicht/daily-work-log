const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('worklog', {
  loadNote:    key            => ipcRenderer.invoke('load-note', key),
  saveNote:    (key, txt)     => ipcRenderer.invoke('save-note', key, txt),
  openFolder:  ()             => ipcRenderer.invoke('open-folder'),
  hide:        ()             => ipcRenderer.invoke('hide-window'),
  getActivity: ()             => ipcRenderer.invoke('get-activity'),
  listMonth:   (year, month)  => ipcRenderer.invoke('list-month', year, month),
  parseMonth:  (year, month)  => ipcRenderer.invoke('parse-month', year, month),
  openWeekly:  date           => ipcRenderer.invoke('open-weekly', date),
  onNavigate:  cb             => ipcRenderer.on('navigate', (_e, payload) => cb(payload)),
})
