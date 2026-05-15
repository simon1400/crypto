// Pocket Option Bridge — content.js (runs in MAIN world)
//
// Перехватывает WebSocket трафик PocketOption и извлекает tick events для OTC активов.
//
// Формат потока PO (реверс 2026-05-14):
//   1. Текстовый фрейм: `451-["updateStream",{"_placeholder":true,"num":0}]`
//      — Socket.IO BINARY_EVENT header, говорит "следующий binary блоб = updateStream".
//   2. Binary blob: UTF-8 JSON. Либо одиночный тик `["AUDCAD_otc",1778800339.668,1.01188]`,
//      либо batch `[["AUDCAD_otc",ts,price],["EURUSD",ts2,price2],...]` — мы поддерживаем
//      оба варианта в emitParsed().
//
// PO открывает несколько WebSocket-ов параллельно к разным регионам (api-eu, api-msk,
// api-us-north и т.д.) — обычно "побеждает" один. Мы патчим САМ КОНСТРУКТОР WebSocket,
// чтобы свой 'message' listener добавлялся при создании каждого WS до того как страница
// успеет повесить свои handlers.
//
// World=MAIN критично — extension в isolated world видит свой wrapper класс WebSocket.

(function () {
  if (window.__poBridgeInstalled) return
  window.__poBridgeInstalled = true

  const OriginalWebSocket = window.WebSocket
  let wsCounter = 0

  function handleMessage(state, data) {
    try {
      if (typeof data === 'string') {
        // 451-["event",...] = Socket.IO BINARY_EVENT header → следующий binary блоб
        // относится к этому event. Прочие текстовые frames (42[...], 0, 40, 3, ping/pong)
        // обнуляют lastEventName.
        const m = data.match(/^45\d+-\["([^"]+)"/)
        state.lastEventName = m ? m[1] : null
        return
      }
      // Binary frame — we care about two events:
      //   updateStream            — live tick (single or batch [symbol, ts, price])
      //   loadHistoryPeriodFast   — historical OHLC candles bulk (warmup)
      //   updateHistoryNewFast    — same but recent block
      const evt = state.lastEventName
      state.lastEventName = null
      const isStream = evt === 'updateStream'
      const isHistory = evt === 'loadHistoryPeriodFast' || evt === 'updateHistoryNewFast'
      if (!isStream && !isHistory) return

      const decode = (buf) => {
        try {
          const text = new TextDecoder('utf-8').decode(buf)
          if (!text.startsWith('[') && !text.startsWith('{')) return null
          return JSON.parse(text)
        } catch { return null }
      }

      const onDecoded = (parsed, sourceEvt) => {
        if (!parsed) return
        if (sourceEvt === 'updateStream') {
          // The WS that delivered this tick is the live one — remember it so
          // we can emit changeSymbol back on the same socket.
          activeWs = state.ws
          emitParsed(parsed)
        } else {
          emitHistory(parsed, sourceEvt)
        }
      }

      if (data instanceof ArrayBuffer) {
        onDecoded(decode(new Uint8Array(data)), evt)
      } else if (data instanceof Blob) {
        data.arrayBuffer().then((ab) => onDecoded(decode(new Uint8Array(ab)), evt)).catch(() => {})
      } else if (ArrayBuffer.isView(data)) {
        onDecoded(decode(data), evt)
      }
    } catch (e) {
      // Silent — don't break page
    }
  }

  // DEBUG: dump first 2 history payloads (per session) so we see the JSON shape
  let historyDumps = 0
  function emitHistory(payload, sourceEvt) {
    if (historyDumps < 2) {
      historyDumps++
      try {
        const sample = JSON.stringify(payload).slice(0, 800)
        console.log(`[PO-Bridge] history sample #${historyDumps} (${sourceEvt}):`, sample)
      } catch { /* */ }
    }
    window.postMessage({
      __poBridge: true,
      type: 'history',
      source: sourceEvt,
      payload,
    }, '*')
  }

  function emitParsed(payload) {
    if (!Array.isArray(payload)) return
    if (Array.isArray(payload[0])) {
      for (const t of payload) emitTick(t)
    } else {
      emitTick(payload)
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
    // First time we see ticks for this asset on this WS — replay the user-click
    // emit shape so PO sends loadHistoryPeriodFast. If we joined the WS after PO
    // already cached the asset, the original history payload was missed and we
    // need a fresh one to seed BB(20).
    requestHistoryIfNeeded(symbol)
  }

  // Track which (ws, asset) pairs we've already requested history for, so we
  // don't spam — exactly one extra changeSymbol per asset per WS lifetime.
  const requestedHistory = new Set()
  let activeWs = null

  function requestHistoryIfNeeded(asset) {
    if (!activeWs || activeWs.readyState !== 1 /* OPEN */) return
    const key = `${activeWs.__poId}:${asset}`
    if (requestedHistory.has(key)) return
    requestedHistory.add(key)
    try {
      const frame = `42["changeSymbol",${JSON.stringify({ asset, period: 60 })}]`
      activeWs.send(frame)
      console.log(`[PO-Bridge] requested history for ${asset} on ws#${activeWs.__poId}`)
    } catch (e) {
      // WS may have closed mid-call — ignore
    }
  }

  // Outbound frame logger + auth rewrite.
  //
  // PO recently started sending `isFastHistory:true,isOptimized:true` in auth.
  // In that mode their server emits `updateHistoryNewFast` (raw ticks for the
  // last ~15s) instead of `loadHistoryPeriodFast` (a full OHLC payload). Tick
  // history is too small to warm BB(20). Rewrite auth to disable those flags
  // so PO falls back to the old protocol that included pre-built candles.
  const sendDumpLimit = 40
  function patchSend(ws, state) {
    const origSend = ws.send.bind(ws)
    ws.send = function (data) {
      try {
        if (typeof data === 'string' && data.startsWith('42["auth",')) {
          const rewritten = data
            .replace(/"isFastHistory"\s*:\s*true/g, '"isFastHistory":false')
            .replace(/"isOptimized"\s*:\s*true/g, '"isOptimized":false')
          if (rewritten !== data) {
            console.log(`[PO-Bridge] ws#${state.id} auth rewritten (disable fast/optimized)`)
            data = rewritten
          }
        }
        if (state.sendDumps < sendDumpLimit && typeof data === 'string') {
          if (data !== '2' && data !== '3' && data.length > 0) {
            state.sendDumps++
            console.log(`[PO-Bridge] ws#${state.id} → ${data.slice(0, 400)}`)
          }
        }
      } catch (e) { /* */ }
      return origSend(data)
    }
  }

  // Wrap the WebSocket constructor. New WS instances automatically get our message listener
  // before any page code can attach handlers.
  window.WebSocket = function PatchedWebSocket(url, protocols) {
    const ws = protocols !== undefined
      ? new OriginalWebSocket(url, protocols)
      : new OriginalWebSocket(url)
    const id = ++wsCounter
    ws.__poId = id
    const state = { id, lastEventName: null, url: String(url), sendDumps: 0, ws }
    ws.addEventListener('message', (ev) => handleMessage(state, ev.data))
    patchSend(ws, state)
    return ws
  }
  window.WebSocket.prototype = OriginalWebSocket.prototype
  Object.defineProperty(window.WebSocket, 'CONNECTING', { value: OriginalWebSocket.CONNECTING })
  Object.defineProperty(window.WebSocket, 'OPEN', { value: OriginalWebSocket.OPEN })
  Object.defineProperty(window.WebSocket, 'CLOSING', { value: OriginalWebSocket.CLOSING })
  Object.defineProperty(window.WebSocket, 'CLOSED', { value: OriginalWebSocket.CLOSED })
  window.WebSocket.__poBridgePatched = true
})()
