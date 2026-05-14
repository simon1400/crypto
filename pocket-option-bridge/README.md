# Pocket Option Bridge

Браузерное расширение для Chrome/Edge которое перехватывает котировки OTC активов с
PocketOption WebSocket и отправляет их на backend Crypto Dashboard для расчёта
BB-touch сигналов.

## Зачем

PocketOption использует **синтетические OTC котировки** для торговли в выходные —
они не доступны ни в одном публичном API (TwelveData, Polygon, OANDA). Единственный
способ получить их — читать прямо из WebSocket который сайт PO открывает в браузере.

Расширение перехватывает эти данные на твоей машине и шлёт их батчами на наш
backend. Backend агрегирует tick-stream в 1m свечи, считает Bollinger Bands и
выдаёт сигналы CALL/PUT через тот же UI что и для regular forex.

## Что внутри

| Файл | Назначение |
|------|-----------|
| `manifest.json` | Chrome Extension Manifest V3 |
| `content.js` | Запускается в MAIN world страницы PO. Патчит `WebSocket.prototype` для перехвата фреймов. Декодирует binary frames (JSON `["SYMBOL_otc", ts, price]`) и шлёт через `window.postMessage` в isolated world. |
| `bridge.js` | Isolated content script. Слушает postMessage от content.js и форвардит в service worker через `chrome.runtime.sendMessage` (другого способа из MAIN world в extension нет). |
| `background.js` | Service worker. Копит тики в буфере, каждые 5 секунд отправляет батчем на `POST /api/binary/otc-ingest`. Реализует retry при сетевых ошибках. |
| `popup.html` + `popup.js` | Простой popup для настройки `Backend URL` и `API Secret`. Показывает live статистику: получено / отправлено / в буфере / ошибки. |

## Установка

1. Открой `chrome://extensions/` (или `edge://extensions/`)
2. Включи **Developer mode** (правый верх)
3. Нажми **Load unpacked** и выбери папку `pocket-option-bridge/`
4. Расширение появится в списке. Нажми на его иконку в toolbar
5. Введи:
   - **Backend URL** — `http://localhost:3020` для локалки, `https://crypto.pechunka.com` для прода
   - **API Secret** — твой `API_SECRET` из `backend/.env` (тот же что используется для логина в UI)
6. Нажми **Сохранить**
7. Открой `pocketoption.com` в новой вкладке, залогинься, открой любой OTC актив на графике
8. Через 5-10 секунд в popup расширения счётчик "Получено тиков" должен начать расти

## Проверка работы

В консоли DevTools на странице PO должно появиться:
```
[PO-Bridge] content script loaded, patching WebSocket.prototype...
[PO-Bridge] WebSocket patched. Awaiting frames.
[PO-Bridge/isolated] ready, forwarding ticks to background
```

В popup расширения видны живые статы:
- **Получено тиков** — счётчик растёт каждую секунду
- **Отправлено** — обновляется каждые 5с
- **Буфер** — обычно 5-50 ticks между отправками
- **Статус: OK, отправляет** (зелёный)

В backend логах:
```
[OtcHelper] AUD/USD OTC CALL @ 0.71234
```

В UI приложения (`/binary`) — переключи режим **OTC (PocketOption)** в шапке.

## Формат данных

Сайт PO шлёт через Socket.IO бинарные event'ы вида `updateStream`:
- **Header (text)**: `451-["updateStream",{"_placeholder":true,"num":0}]`
- **Binary blob**: UTF-8 JSON `["BNB-USD_otc",1778799110.116,623.4741]`
  - `[0]` — symbol (e.g. `EURUSD_otc`, `BNB-USD_otc`, `AED-CNY_otc`)
  - `[1]` — timestamp в секундах (float, миллисекундная точность)
  - `[2]` — текущая цена

PO рассылает тики по **всем** OTC активам в одном WS, а не только по выбранному
на графике. Это удобно — расширение получает данные по 20+ парам сразу без
необходимости подписки.

## Безопасность

- Все запросы делаются с твоего IP с твоей сессии PO (не используются никакие учётки)
- API Secret хранится в `chrome.storage.local` — недоступен другим страницам
- Никаких ордеров расширение не отправляет, только читает котировки

## Известные ограничения

- **Требует открытой вкладки** с pocketoption.com — расширение работает только пока эта страница активна
- **Не работает в incognito** без явного разрешения
- **PO может изменить формат WS** — тогда нужно обновить парсер в `content.js`. Текущая версия проверена 2026-05-14
- **Если расширение перегружено** (>5000 тиков в буфере), старые отбрасываются

## Headless вариант (для VPS)

Если хочешь чтобы расширение работало 24/7 без открытого браузера на твоей машине —
можно поднять на VPS Chromium headless со включённым этим расширением и
залогиненной сессией PO. Это вне scope текущей реализации, но технически
делается через Puppeteer + `--load-extension`.
