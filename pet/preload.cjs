/**
 * The pet window's only privileged surface.
 *
 * The renderer runs with context isolation and no Node integration; the handful
 * of window commands it needs (hide, quit, always-on-top, resize) cross this
 * bridge as explicit, argument-checked calls.
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('whalePetWindow', {
  /** Tell the main process the renderer finished its first paint. */
  ready: () => ipcRenderer.send('pet:ready'),
  /** Hide the window without exiting. */
  hide: () => ipcRenderer.invoke('pet:hide'),
  /** Show the window again. */
  show: () => ipcRenderer.invoke('pet:show'),
  /** Quit the pet window process. */
  quit: () => ipcRenderer.invoke('pet:quit'),
  /** Read the current always-on-top preference. */
  getTopmost: () => ipcRenderer.invoke('pet:get-topmost'),
  /** Set the always-on-top preference. */
  setTopmost: value => ipcRenderer.invoke('pet:set-topmost', value === true),
  /** Resize the window, clamped by the main process. */
  resize: size => ipcRenderer.invoke('pet:resize', size),
  /** Move the window by a screen delta (drag-to-move; fire-and-forget). */
  moveBy: (dx, dy) => ipcRenderer.send('pet:move-by', dx, dy),
  /** Write one diagnostic line into the host log. */
  log: message => ipcRenderer.invoke('pet:log', String(message)),
})
