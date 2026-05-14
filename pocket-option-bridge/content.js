// Pocket Option Bridge — content.js (runs in MAIN world)
//
// Перехватывает WebSocket трафик PocketOption и извлекает tick events для OTC активов.
//
// Формат потока PO (реверс-инжиниринг 2026-05-14):
//   1. Текстовый фрейм: `451-["updateStream",{"_placeholder":true,"num":0}]`
//      — Socket.IO BINARY_EVENT header, говорит "следующий binary блоб = updateStream".
//   2. Binary blob: UTF-8 JSON `["AUDCAD_otc", 1778800339.668, 1.01188]`
//      — массив [symbol, timestamp_seconds, price].
//
// PO открывает несколько WebSocket-ов параллельно к разным регионам (api-eu, api-msk,
// api-us-north и т.д.) — обычно "побеждает" один (тот что быстрее ответил handshake).
// Мы патчим САМ КОНСТРУКТОР WebSocket, чтобы свой 'message' listener добавлялся
// сразу при создании каждого WS — независимо от того что делает страница.
//
// World=MAIN критично — extension в isolated world видит свой wrapper класс WebSocket,
// а не оригинальный.

(function () {
  if (window.__poBridgeInstalled) return
  window.__poBridgeInstalled = true

  const log = (...args) => console.log('[PO-Bridge]', ...args)
  log('content script loaded, hooking WebSocket constructor...')

  const OriginalWebSocket = window.WebSocket
  let wsCounter = 0

  function handleMessage(state, data) {
    try {
      // DEBUG: log first few frames per WS so we see in console whether we receive anything
      if (state.framesSeen < 5) {
        state.framesSeen++
        const kind = typeof data === 'string'
          ? `text(${data.length}b): ${data.slice(0, 80)}`
          : data instanceof ArrayBuffer
            ? `ArrayBuffer(${data.byteLength}b)`
            : data instanceof Blob
              ? `Blob(${data.size}b)`
              : `other(${data?.constructor?.name})`
        console.log(`[PO-Bridge] WS#${state.id} frame#${state.framesSeen}: ${kind}`)
      }
      if (typeof data === 'string') {
        // Socket.IO text frame patterns:
        //   "42[\"event\",{...}]"        — plain event with JSON payload
        //   "451-[\"event\",{...}]"      — binary event header (one binary attachment follows)
        //   "0", "40", "3", etc.         — engine.io control frames
        const m = data.match(/^45\d+-\["([^"]+)"/)
        state.lastEventName = m ? m[1] : null
        return
      }
      // Binary frame
      if (state.lastEventName !== 'updateStream') {
        state.lastEventName = null
        return
      }
      state.lastEventName = null

      const decode = (buf) => {
        try {
          const text = new TextDecoder('utf-8').decode(buf)
          if (!text.startsWith('[')) return null
          return JSON.parse(text)
        } catch { return null }
      }

      if (data instanceof ArrayBuffer) {
        const tick = decode(new Uint8Array(data))
        if (tick) emitTick(tick)
      } else if (data instanceof Blob) {
        data.arrayBuffer().then((ab) => {
          const tick = decode(new Uint8Array(ab))
          if (tick) emitTick(tick)
        }).catch(() => {})
      } else if (ArrayBuffer.isView(data)) {
        const tick = decode(data)
        if (tick) emitTick(tick)
      }
    } catch (e) {
      // Silent — don't break page
    }
  }

  function emitTick(tick) {
    if (!Array.isArray(tick) || tick.length < 3) return
    const [symbol, ts, price] = tick
    if (typeof symbol !== 'string' || typeof ts !== 'number' || typeof price !== 'number') return
    window.postMessage({
      __poBridge: true,
      type: 'tick',
      symbol,
      ts,
      price,
    }, '*')
  }

  // Wrap the WebSocket constructor. New WS instances automatically get our message listener
  // before any page code can attach handlers.
  window.WebSocket = function PatchedWebSocket(url, protocols) {
    const ws = protocols !== undefined
      ? new OriginalWebSocket(url, protocols)
      : new OriginalWebSocket(url)
    const state = { id: ++wsCounter, lastEventName: null, url: String(url), framesSeen: 0 }
    log(`WS#${state.id} created → ${state.url}`)
    ws.addEventListener('message', (ev) => handleMessage(state, ev.data))
    ws.addEventListener('open', () => log(`WS#${state.id} open`))
    ws.addEventListener('close', () => log(`WS#${state.id} closed`))
    return ws
  }
  // Preserve static fields & prototype chain so `instanceof WebSocket` still works for page code.
  window.WebSocket.prototype = OriginalWebSocket.prototype
  Object.defineProperty(window.WebSocket, 'CONNECTING', { value: OriginalWebSocket.CONNECTING })
  Object.defineProperty(window.WebSocket, 'OPEN', { value: OriginalWebSocket.OPEN })
  Object.defineProperty(window.WebSocket, 'CLOSING', { value: OriginalWebSocket.CLOSING })
  Object.defineProperty(window.WebSocket, 'CLOSED', { value: OriginalWebSocket.CLOSED })

  // Marker for diagnostics: page can check `WebSocket.__poBridgePatched === true`
  window.WebSocket.__poBridgePatched = true

  log('WebSocket constructor patched. Awaiting connections.')
})()
