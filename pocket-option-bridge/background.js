// Pocket Option Bridge — background.js (service worker)
//
// Принимает тики от content scripts (всех вкладок), копит в буфер, батчем отправляет
// на наш backend каждые BATCH_INTERVAL_MS секунд. Так мы:
//   1. не молотим backend по одному запросу на каждый тик (их сотни в минуту)
//   2. переживаем кратковременные сетевые ошибки без потери данных
//   3. сглаживаем нагрузку
//
// MV3 service worker архитектура: worker может засыпать когда нет событий, но каждое
// входящее tick-сообщение его пробуждает. Используем chrome.alarms (минимум 30с в unpacked)
// как fallback heartbeat если PO замолчит, плюс ленивая проверка возраста буфера на каждом
// входящем сообщении — если прошло >5с от прошлого flush, шлём сразу.

const DEFAULT_BACKEND_URL = 'http://localhost:3020'
const DEFAULT_API_SECRET = ''
const BATCH_INTERVAL_MS = 5_000
const MAX_BUFFER = 5000
const ALARM_PERIOD_MIN = 0.5    // 30 секунд — минимум для unpacked extensions в MV3

let buffer = []
let lastFlushAt = 0
let stats = {
  totalReceived: 0,
  totalSent: 0,
  totalErrors: 0,
  lastError: null,
  lastFlushAt: null,
}

let backendUrl = DEFAULT_BACKEND_URL
let apiSecret = DEFAULT_API_SECRET

chrome.storage.local.get(['backendUrl', 'apiSecret'], (s) => {
  if (s.backendUrl) backendUrl = s.backendUrl
  if (s.apiSecret) apiSecret = s.apiSecret
  console.log('[PO-Bridge/bg] loaded settings, backend:', backendUrl)
})

chrome.storage.onChanged.addListener((changes) => {
  if (changes.backendUrl) backendUrl = changes.backendUrl.newValue
  if (changes.apiSecret) apiSecret = changes.apiSecret.newValue
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'tick' && msg.symbol && msg.ts && msg.price) {
    stats.totalReceived++
    buffer.push({ symbol: msg.symbol, ts: msg.ts, price: msg.price })
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
    if (Date.now() - lastFlushAt >= BATCH_INTERVAL_MS) {
      flush()
    }
  } else if (msg?.type === 'history' && msg.payload) {
    // Forward warmup candle history to backend immediately (separate endpoint)
    sendHistory(msg.payload, msg.source).catch(() => {})
  } else if (msg?.type === 'getStats') {
    sendResponse({ ...stats, bufferSize: buffer.length, backendUrl })
    return true
  }
})

async function sendHistory(payload, source) {
  try {
    const res = await fetch(`${backendUrl}/api/binary/otc-history-ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Secret': apiSecret,
      },
      body: JSON.stringify({ source, payload }),
    })
    if (!res.ok) {
      stats.lastError = `history HTTP ${res.status}`
    } else {
      stats.lastError = null
    }
  } catch (e) {
    stats.lastError = e.message || String(e)
  }
}

async function flush() {
  if (buffer.length === 0) return
  lastFlushAt = Date.now()
  const batch = buffer
  buffer = []
  try {
    const res = await fetch(`${backendUrl}/api/binary/otc-ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Secret': apiSecret,
      },
      body: JSON.stringify({ ticks: batch }),
    })
    if (!res.ok) {
      stats.totalErrors++
      stats.lastError = `HTTP ${res.status}`
      buffer = batch.concat(buffer)
      if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
    } else {
      stats.totalSent += batch.length
      stats.lastFlushAt = Date.now()
      stats.lastError = null
    }
  } catch (e) {
    stats.totalErrors++
    stats.lastError = e.message || String(e)
    buffer = batch.concat(buffer)
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
  }
}

// Fallback heartbeat: если PO ничего не шлёт, всё равно периодически просыпаемся
// и пробуем выгрузить буфер. Минимальный period для MV3 unpacked = 30с.
chrome.alarms.create('po-flush', { periodInMinutes: ALARM_PERIOD_MIN })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'po-flush') flush()
})

console.log('[PO-Bridge/bg] service worker started')
