const { contextBridge, ipcRenderer, clipboard, shell } = require ('electron');

contextBridge.exposeInMainWorld ('logger', (() => {
  let bridge = {};

  for (let level of [ 'info', 'warn', 'error', 'debug' ]) {
    bridge [level] = (message, meta = {}) => {
      ipcRenderer.send ('log', { level, message, meta });
    };
  }

  return bridge;
}) ());

contextBridge.exposeInMainWorld ('electron', {
  send: (channel, data) => {
    ipcRenderer.send (channel, data);
  },
  
  on: (channel, func) => {
    const wrapper = (event, ...args) => func (...args);
    ipcRenderer.addListener (channel, wrapper);
    return () => ipcRenderer.removeListener (channel, wrapper);
  },
  
  off: (channel, func) => {
    ipcRenderer.removeListener (channel, func);
  },

  once: (channel, func) => {
    ipcRenderer.once (channel, (event, ... args) => func (... args));
  },

  invoke: (channel, ...args) => ipcRenderer.invoke (channel, ...args),
  clipboardWriteText: (text) => clipboard.writeText (text),
  openExternal: (url) => shell.openExternal (url)
});