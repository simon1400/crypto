const backendInp = document.getElementById('backendUrl')
const secretInp = document.getElementById('apiSecret')
const saveBtn = document.getElementById('save')
const els = {
  totalReceived: document.getElementById('totalReceived'),
  totalSent: document.getElementById('totalSent'),
  bufferSize: document.getElementById('bufferSize'),
  totalErrors: document.getElementById('totalErrors'),
  status: document.getElementById('status'),
}

chrome.storage.local.get(['backendUrl', 'apiSecret'], (s) => {
  backendInp.value = s.backendUrl || 'http://localhost:3020'
  secretInp.value = s.apiSecret || ''
})

saveBtn.addEventListener('click', () => {
  chrome.storage.local.set({
    backendUrl: backendInp.value.trim().replace(/\/$/, ''),
    apiSecret: secretInp.value.trim(),
  }, () => {
    saveBtn.textContent = 'Сохранено ✓'
    setTimeout(() => saveBtn.textContent = 'Сохранить', 1500)
  })
})

function refreshStats() {
  chrome.runtime.sendMessage({ type: 'getStats' }, (r) => {
    if (!r) return
    els.totalReceived.textContent = r.totalReceived
    els.totalSent.textContent = r.totalSent
    els.bufferSize.textContent = r.bufferSize
    els.totalErrors.textContent = r.totalErrors
    if (r.lastError) {
      els.status.textContent = 'Ошибка: ' + r.lastError
      els.status.className = 'stat-val err'
    } else if (r.totalSent > 0) {
      els.status.textContent = 'OK, отправляет'
      els.status.className = 'stat-val ok'
    } else {
      els.status.textContent = 'Ожидание тиков…'
      els.status.className = 'stat-val'
    }
  })
}

refreshStats()
setInterval(refreshStats, 1500)
