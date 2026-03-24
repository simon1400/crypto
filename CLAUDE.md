# Crypto Analysis Dashboard

## Обзор проекта

Full-stack SPA для анализа крипторынка по запросу.
Пользователь выбирает монеты, нажимает кнопку — получает торговый план от Claude Opus.
Никакого cron, никакого Telegram. Всё в интерфейсе.

## Стек

- **Frontend:** React 18 + Vite + TypeScript + Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **БД:** PostgreSQL через Prisma ORM
- **AI:** Anthropic SDK, модель `claude-opus-4-5`
- **Деплой:** Ubuntu VPS — Nginx (фронт) + PM2 (бэкенд)

---

## Структура монорепо

```
crypto-dashboard/
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx
│   │   │   └── History.tsx
│   │   ├── components/
│   │   │   ├── CoinSelector.tsx
│   │   │   ├── AnalysisResult.tsx
│   │   │   ├── AnalysisCard.tsx
│   │   │   ├── MarketBadge.tsx
│   │   │   ├── LoadingAnalysis.tsx
│   │   │   ├── HistoryTable.tsx
│   │   │   └── Navbar.tsx
│   │   ├── api/
│   │   │   └── client.ts
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── index.html
│   ├── vite.config.ts
│   ├── .env.example
│   └── package.json
│
└── backend/
    ├── src/
    │   ├── routes/
    │   │   ├── analyze.ts
    │   │   ├── market.ts
    │   │   └── history.ts
    │   ├── services/
    │   │   ├── market.ts
    │   │   ├── indicators.ts
    │   │   └── claude.ts
    │   ├── db/
    │   │   └── prisma.ts
    │   ├── middleware/
    │   │   └── auth.ts
    │   └── index.ts
    ├── prisma/
    │   └── schema.prisma
    ├── ecosystem.config.js
    ├── .env.example
    └── package.json
```

---

## База данных

```prisma
// backend/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Analysis {
  id         Int      @id @default(autoincrement())
  createdAt  DateTime @default(now())
  coins      String
  marketData Json
  coinsData  Json
  result     String
}
```

---

## Backend сервисы

### services/market.ts

```typescript
interface OHLCV {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface MarketOverview {
  fearGreed: number
  fearGreedLabel: string
  btcDominance: number
}

// fetchOHLCV(symbol: string, interval = '4h', limit = 60): Promise<OHLCV[]>
// GET https://api.binance.com/api/v3/klines
// params: symbol (пример "BTCUSDT"), interval, limit

// fetchMarketOverview(): Promise<MarketOverview>
// Fear&Greed → GET https://api.alternative.me/fng/?limit=1
//   data[0].value, data[0].value_classification
// BTC Dominance → GET https://api.coingecko.com/api/v3/global
//   data.market_cap_percentage.btc — округлить до 1 знака
```

### services/indicators.ts

Реализовать вручную, без внешних библиотек:

```typescript
interface CoinIndicators {
  price: number
  ema20: number
  ema50: number
  rsi: number
  trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS'
  support: number      // min(lows за последние 20 свечей)
  resistance: number   // max(highs за последние 20 свечей)
  volRatio: number     // volume[-1] / avg(volume за 20 свечей), 2 знака
  change24h: number    // (close[-1] - close[-6]) / close[-6] * 100, 2 знака
}

// ema(values: number[], period: number): number[]
// k = 2 / (period + 1)
// result[i] = values[i] * k + result[i-1] * (1 - k)

// rsi(closes: number[], period = 14): number
// Wilder RSI. Если avgLoss === 0 → вернуть 100

// computeIndicators(candles: OHLCV[]): CoinIndicators
// trend:
//   BULLISH  → ema20 > ema50 && price > ema20
//   BEARISH  → ema20 < ema50 && price < ema20
//   SIDEWAYS → иначе
```

### services/claude.ts

```typescript
// Модель: claude-opus-4-5  ← НЕ МЕНЯТЬ
// max_tokens: 3000
// Используй @anthropic-ai/sdk

const SYSTEM = `Ты профессиональный крипто-трейдер.
Анализируешь рынок для краткосрочных сделок (несколько часов).
Давай конкретные цифры. Соблюдай риск-менеджмент строго.`

// USER промпт — подставлять реальные данные:
`
Время анализа: ${datetime}

СОСТОЯНИЕ РЫНКА:
- Fear & Greed: ${fearGreed} (${fearGreedLabel})
- BTC Dominance: ${btcDominance}%

${coinsText}
// Для каждой монеты:
// ## BTC — $97,432
// EMA20: $96,100 | EMA50: $94,800 | RSI: 58 | Тренд: BULLISH
// Поддержка: $95,200 | Сопротивление: $98,800
// Объём: 1.4x от среднего | Изменение 24h: +2.3%

ЗАДАЧА: Для каждой монеты — торговый план для входа прямо сейчас.

Формат для КАЖДОЙ монеты:

🪙 [TICKER] — $[цена]
📊 Тренд: [BULLISH/BEARISH/SIDEWAYS]
🎯 Сигнал: [LONG / SHORT / ПРОПУСТИТЬ]
💰 Вход: $[цена]
🛑 Stop Loss: $[цена] (−[X]%)
✅ Take Profit 1: $[цена] (+[X]%)
✅ Take Profit 2: $[цена] (+[X]%)
⚖️ Risk/Reward: 1:[X]
📝 Причины:
  • [причина 1]
  • [причина 2]
  • [причина 3]
⚠️ Риски:
  • [риск 1]
  • [риск 2]

---

ПРАВИЛА (нарушать нельзя):
- RSI > 70 + BULLISH → ПРОПУСТИТЬ (перекуплен)
- RSI < 30 + BEARISH → ПРОПУСТИТЬ (перепродан)
- SL для LONG → ниже support
- SL для SHORT → выше resistance
- TP1 = ближайший уровень, TP2 = следующий
- R:R минимум 1:1.5
- volRatio < 0.8 → пометить: ⚠️ Слабый объём
- Нет чёткого сетапа → ПРОПУСТИТЬ с объяснением

В конце:
📋 ИТОГ: [2-3 предложения: общее состояние рынка и рекомендация на ближайшие часы]
`
```

---

## Backend API роуты

### POST /api/analyze
```typescript
// Body: { coins: string[] }
// Допустимые монеты: BTC ETH SOL BNB XRP ADA AVAX DOT MATIC LINK
// Логика:
//   1. fetchMarketOverview()
//   2. Для каждой монеты: fetchOHLCV(coin+"USDT") → computeIndicators()
//   3. analyzeWithClaude(coinsData, market)
//   4. Сохранить в БД
//   5. Вернуть: { id, result, coinsData, marketData, createdAt }
// Timeout: 120 секунд
// Если уже запущен → 409 { error: "Analysis already running" }
// Использовать in-memory флаг isRunning: boolean
```

### GET /api/market
```typescript
// Вернуть fetchMarketOverview() — для MarketBadge при открытии страницы
```

### GET /api/history
```typescript
// Query: page=1, limit=10
// Response: { data: Analysis[], total: number, page: number, totalPages: number }
// Сортировка: createdAt DESC
```

### GET /api/history/:id
```typescript
// Response: полный объект Analysis
```

### middleware/auth.ts
```typescript
// Проверять header X-Api-Secret
// Неверный → 401 { error: "Unauthorized" }
// Применять ко всем /api/* роутам
```

---

## Frontend компоненты

### Dashboard.tsx — три состояния

**IDLE:**
- Заголовок "Crypto Analysis"
- MarketBadge — грузится сразу при открытии
- CoinSelector
- Кнопка "Анализировать"

**LOADING:**
- Сообщения меняются каждые 3 сек:
  `["Получаю данные Binance...", "Считаю индикаторы...", "Claude анализирует рынок...", "Формирую торговый план..."]`
- Кнопка заблокирована

**RESULT:**
- MarketBadge
- AnalysisCard для каждой монеты
- Дата/время анализа
- Кнопка "Новый анализ" → сброс в IDLE

### CoinSelector.tsx
```typescript
// Монеты: BTC ETH SOL BNB XRP ADA AVAX DOT MATIC LINK
// UI: кликабельные чипы
// Выбрать 1–5 монет
// Дефолт: BTC, ETH, SOL
// Выбран: border + text #f0b90b, bg rgba(240,185,11,0.1)
```

### AnalysisCard.tsx
```typescript
// Показывает для одной монеты:
// - Тикер + цена (JetBrains Mono)
// - Бейдж тренда (цвет по значению)
// - Сигнал КРУПНО: LONG (зелёный) / SHORT (красный) / ПРОПУСТИТЬ (серый)
// - Сетка: Вход | SL | TP1 | TP2 | R:R
// - RSI прогресс-бар: <30 зелёный, 30-70 жёлтый, >70 красный
// - Объём ratio
// - Причины (видно сразу)
// - Риски (accordion)
```

### MarketBadge.tsx
```typescript
// Fear&Greed цвета:
//   0-25   Extreme Fear → #f6465d
//   26-45  Fear         → #ff9900
//   46-55  Neutral      → #848e9c
//   56-75  Greed        → #00c087
//   76-100 Extreme Greed→ #0ecb81 яркий
// BTC Dominance рядом
```

### History.tsx
```typescript
// Таблица: дата/время | монеты | кнопка "Смотреть"
// Клик → modal с полным текстом result
// Пагинация
```

### api/client.ts
```typescript
const BASE   = import.meta.env.VITE_API_URL
const SECRET = import.meta.env.VITE_API_SECRET

// Все запросы: headers { 'X-Api-Secret': SECRET, 'Content-Type': 'application/json' }

export async function runAnalysis(coins: string[]): Promise<AnalysisResponse>
export async function getMarketOverview(): Promise<MarketOverview>
export async function getHistory(page: number): Promise<HistoryResponse>
export async function getAnalysis(id: number): Promise<Analysis>
```

---

## Дизайн

Тёмная тема, стиль торгового терминала.

```css
:root {
  --bg-primary:    #0b0e11;
  --bg-card:       #1e2329;
  --bg-input:      #2b3139;
  --accent:        #f0b90b;
  --long:          #0ecb81;
  --short:         #f6465d;
  --neutral:       #848e9c;
  --text-primary:  #eaecef;
  --text-secondary:#848e9c;
}
```

Шрифты в index.html:
```html
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
```

- UI текст: IBM Plex Sans
- Числа и цены: JetBrains Mono
- Адаптивная сетка карточек: 1 колонка мобиль / 3 десктоп

---

## Переменные окружения

### backend/.env.example
```
DATABASE_URL=postgresql://user:password@localhost:5432/crypto_dashboard
ANTHROPIC_API_KEY=sk-ant-xxxxx
API_SECRET=random-32-char-secret
PORT=3001
```

### frontend/.env.example
```
VITE_API_URL=http://YOUR_VPS_IP
VITE_API_SECRET=тот-же-API_SECRET
```

---

## PM2

```javascript
// backend/ecosystem.config.js
module.exports = {
  apps: [{
    name: 'crypto-backend',
    script: 'dist/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    env: { NODE_ENV: 'production', PORT: 3001 }
  }]
}
```

---

## DEPLOY.md — создать отдельным файлом в корне

Включить:

### 1. PostgreSQL
```bash
sudo -u postgres psql
CREATE DATABASE crypto_dashboard;
CREATE USER crypto_user WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE crypto_dashboard TO crypto_user;
\q
```

### 2. Билд
```bash
# Backend
cd backend && cp .env.example .env
npm install && npm run build
npx prisma migrate deploy

# Frontend
cd ../frontend && cp .env.example .env
npm install && npm run build
```

### 3. PM2
```bash
cd backend
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

### 4. Nginx
```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN_OR_IP;

    root /var/www/crypto-dashboard;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_read_timeout 120s;
    }
}
```

```bash
sudo cp -r frontend/dist/* /var/www/crypto-dashboard/
sudo nginx -t && sudo systemctl reload nginx
```

### 5. Проверка
```bash
pm2 logs crypto-backend
curl -X POST http://localhost:3001/api/analyze \
  -H "Content-Type: application/json" \
  -H "X-Api-Secret: YOUR_SECRET" \
  -d '{"coins":["BTC","ETH"]}'
```