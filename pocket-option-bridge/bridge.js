// Pocket Option Bridge — bridge.js (isolated content script world)
//
// Слушает window.postMessage от content.js (MAIN world) и пересылает в background.
// Это единственный способ передачи данных между MAIN world и extension service worker.

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return
  const msg = ev.data
  if (!msg || msg.__poBridge !== true) return
  try {
    chrome.runtime.sendMessage(msg)
  } catch (e) {
    // Extension context invalidated (e.g. extension reloaded) — page will reload eventually
  }
})

console.log('[PO-Bridge/isolated] ready, forwarding ticks to background')
