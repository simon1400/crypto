// Pocket Option Bridge — content.js (runs in MAIN world)
//
// Перехватывает WebSocket трафик PocketOption и извлекает tick events для OTC активов.
//
// Формат потока PO (по результатам реверс-инжиниринга 2026-05-14):
//   1. Текстовый фрейм:  `451-["updateStream",{"_placeholder":true,"num":0}]`
//      — это Socket.IO BINARY_EVENT с placeholder. Говорит "следующий бинарный фрейм
//      относится к событию updateStream и подставляется на место placeholder".
//   2. Бинарный фрейм:   UTF-8 JSON `["BNB-USD_otc", 1778799110.116, 623.4741]`
//      — массив [symbol, timestamp_seconds, price].
//
// PO рассылает тики по ВСЕМ OTC активам в одном WS — не только по выбранному на графике.
// Это значит мы получаем поток данных для 20+ пар бесплатно, без подписки.
//
// World=MAIN критичен: иначе мы не видим оригинальный WebSocket объект (extension в
// isolated world получает свой свой класс WebSocket в обёртке).

(function () {
  if (window.__poBridgeInstalled) return
  window.__poBridgeInstalled = true

  const log = (...args) => console.log('[PO-Bridge]', ...args)
  log('content script loaded, patching WebSocket.prototype...')

  const originalSend = WebSocket.prototype.send
  const originalAddEventListener = WebSocket.prototype.addEventListener

  // We watch the most recent inbound text frame so we can pair it with the next binary frame.
  // Socket.IO BINARY_EVENT splits a single logical event into:
  //   text header  →  "451-["updateStream",{"_placeholder":true,"num":0}]"
  //   binary blob  →  raw JSON bytes
  // We need to know that the next blob is "updateStream" to bother decoding it.
  const wsState = new WeakMap()

  function ensureState(ws) {
    let s = wsState.get(ws)
    if (!s) {
      s = { lastEventName: null, attached: false }
      wsState.set(ws, s)
    }
    return s
  }

  function handleMessage(ws, data) {
    const state = ensureState(ws)
    try {
      if (typeof data === 'string') {
        // Socket.IO text frame. Header format examples:
        //   "42[\"event\",{...}]"        — plain event with JSON payload
        //   "451-[\"event\",{...}]"      — binary event header (one binary attachment follows)
        //   "452-[\"event\",...]"        — binary event with 2 attachments
        //   "0", "40", "3" etc.          — engine.io control frames
        const m = data.match(/^45\d+-\["([^"]+)"/)
        if (m) {
          state.lastEventName = m[1]
        } else {
          state.lastEventName = null
        }
        return
      }

      // Binary frame: ArrayBuffer or Blob
      if (state.lastEventName !== 'updateStream') return  // ignore other binary events
      state.lastEventName = null   // consume — each binary follows exactly one header

      // Decode to JSON
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
      }
    } catch (e) {
      console.warn('[PO-Bridge] decode error', e)
    }
  }

  function emitTick(tick) {
    // tick = [symbol, timestamp_seconds, price]
    if (!Array.isArray(tick) || tick.length < 3) return
    const [symbol, ts, price] = tick
    if (typeof symbol !== 'string' || typeof ts !== 'number' || typeof price !== 'number') return
    // Send to isolated content script via window.postMessage (extension boundary)
    window.postMessage({
      __poBridge: true,
      type: 'tick',
      symbol,
      ts,                  // seconds, float (ms precision)
      price,
    }, '*')
  }

  // Patch addEventListener to intercept 'message' before page handlers
  WebSocket.prototype.addEventListener = function (type, listener, options) {
    if (type === 'message') {
      const state = ensureState(this)
      if (!state.attached) {
        state.attached = true
        originalAddEventListener.call(this, 'message', (ev) => handleMessage(this, ev.data))
      }
    }
    return originalAddEventListener.apply(this, arguments)
  }

  // Patch direct .onmessage assignment via Object.defineProperty getter/setter
  const protoMsgDesc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage')
  if (protoMsgDesc && protoMsgDesc.set) {
    Object.defineProperty(WebSocket.prototype, 'onmessage', {
      ...protoMsgDesc,
      set(fn) {
        const state = ensureState(this)
        if (!state.attached) {
          state.attached = true
          originalAddEventListener.call(this, 'message', (ev) => handleMessage(this, ev.data))
        }
        return protoMsgDesc.set.call(this, fn)
      },
    })
  }

  // Patch send so the bridge announces itself even if PO only ever calls send
  WebSocket.prototype.send = function (data) {
    const state = ensureState(this)
    if (!state.attached) {
      state.attached = true
      originalAddEventListener.call(this, 'message', (ev) => handleMessage(this, ev.data))
    }
    return originalSend.apply(this, arguments)
  }

  log('WebSocket patched. Awaiting frames.')
})()
