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
});
