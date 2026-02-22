const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('croncast', {
  getVersion: () => ipcRenderer.sendSync('get-version'),
  onUpdateAvailable: (cb) => {
    ipcRenderer.on('update-available', () => cb());
  },
  onUpdateDownloaded: (cb) => {
    ipcRenderer.on('update-downloaded', () => cb());
  },
  installUpdate: () => ipcRenderer.send('install-update'),
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
  selectFile: (defaultPath) => ipcRenderer.invoke('select-file', defaultPath),
  detectChrome: () => ipcRenderer.invoke('detect-chrome'),
  selectFolder: (defaultPath) => ipcRenderer.invoke('select-folder', defaultPath),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
});
