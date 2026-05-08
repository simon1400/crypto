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

<!-- GSD:project-start source:PROJECT.md -->
## Project

**Crypto Auto-Trading**

Модуль автоматического трейдинга для существующего Crypto Dashboard. Подключается к бирже Bybit и автоматически (или по кнопке) открывает позиции на основе торговых сигналов из Telegram-каналов (EveningTrader, Near512). Управление через веб-интерфейс.

**Core Value:** Сигнал из Telegram-канала превращается в реальный ордер на Bybit без ручного копирования — быстро, с контролем рисков и прозрачностью через UI.

### Constraints

- **Биржа**: Только Bybit — API ключи хранятся в БД (зашифрованные) или .env
- **Безопасность**: API ключи никогда не отдаются на фронтенд, все торговые операции через backend
- **Стек**: TypeScript, Express, React, Prisma — как в остальном проекте
- **Деплой**: Ubuntu VPS, PM2, тот же сервер что и основное приложение
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- TypeScript 5.7.3 - Used across both frontend and backend
- JavaScript - PM2 config (`backend/ecosystem.config.js`), PostCSS/Tailwind configs
- SQL - Prisma migrations (auto-generated)
## Runtime
- Node.js (version not pinned; no `.nvmrc` or `engines` field)
- Target: ES2022 in both `backend/tsconfig.json` and `frontend/tsconfig.json`
- npm
- Lockfiles: `backend/package-lock.json` and `frontend/package-lock.json` (both present)
## Frameworks
- Express 4.21.2 - Backend HTTP server (`backend/src/index.ts`)
- React 18.3.1 - Frontend SPA (`frontend/src/main.tsx`)
- React Router DOM 7.3.0 - Client-side routing (`frontend/src/App.tsx`)
- Not detected - no test framework installed in either package.json
- Vite 6.2.2 - Frontend build tool (`frontend/vite.config.ts`)
- `@vitejs/plugin-react` 4.3.4 - React Fast Refresh for dev
- `tsc` (TypeScript compiler) - Backend build (`backend/package.json` scripts)
- `tsx` 4.19.3 - Backend dev mode with watch (`tsx watch src/index.ts`)
## Key Dependencies
- `@prisma/client` 6.4.1 - PostgreSQL ORM, all database access (`backend/src/db/prisma.ts`)
- `prisma` 6.4.1 (dev) - Schema management and migrations
- `telegram` 2.26.22 - GramJS client for reading Telegram channels (`backend/src/services/telegram.ts`)
- `@cryptography/aes` 0.1.1 - Required by telegram library for MTProto encryption
- `react` 18.3.1 / `react-dom` 18.3.1 - UI framework
- `react-router-dom` 7.3.0 - Page routing
- `lightweight-charts` 5.1.0 - TradingView charting library for price display
- `express` 4.21.2 - HTTP server
- `cors` 2.8.5 - Cross-origin resource sharing
- `dotenv` 16.6.1 - Environment variable loading
- `tailwindcss` 3.4.17 - Utility-first CSS
- `postcss` 8.5.3 - CSS processing pipeline
- `autoprefixer` 10.4.20 - Vendor prefix automation
## Configuration
- Target: ES2022, Module: CommonJS
- Strict mode enabled
- Output: `backend/dist/`
- Root: `backend/src/`
- Target: ES2022, Module: ESNext, JSX: react-jsx
- Module resolution: bundler
- Strict mode enabled, noEmit (Vite handles bundling)
- Dev server port: 5173
- API proxy: `/api` -> `http://localhost:3001`
- Custom color palette: trading terminal dark theme
- Custom fonts: IBM Plex Sans (UI), JetBrains Mono (numbers/prices)
- Content paths: `./index.html`, `./src/**/*.{js,ts,jsx,tsx}`
- Plugins: tailwindcss, autoprefixer
- `.env` files present in both `backend/` and `frontend/` (with `.env.example` templates)
- Backend env vars: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `API_SECRET`, `PORT`, `APP_PASSWORD`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `OPENAI_API_KEY`
- Frontend env vars: `VITE_API_URL`, `VITE_API_SECRET`
## Database
- ORM: Prisma 6.4.1
- Schema: `backend/prisma/schema.prisma`
- Client singleton: `backend/src/db/prisma.ts`
- `Signal` - Telegram-sourced trading signals with price tracking
- `GeneratedSignal` - DEPRECATED, scanner module removed 2026-05-08; table retained for historical data only
- `Trade` - Manual trade journal entries with partial close support
- `BreakoutSignal` / `BreakoutPaperTrade` - Daily Breakout strategy live + paper trading
## Process Management
- PM2 (`backend/ecosystem.config.js`)
- Single instance, auto-restart, no file watching
- Production port: 3001
- Backend: `tsx watch src/index.ts` (auto-reload on file changes)
- Frontend: `vite` dev server on port 5173 with HMR
## Platform Requirements
- Node.js with ES2022 support (v18+)
- PostgreSQL database
- Telegram API credentials (API ID + Hash + authenticated session)
- Ubuntu VPS
- Nginx as reverse proxy (serves frontend static, proxies `/api` to backend)
- PM2 for backend process management
- PostgreSQL instance
- SSL via Let's Encrypt (per deploy docs)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## TypeScript Configuration
- Target: ES2022, Module: CommonJS
- `strict: true` enabled
- `esModuleInterop: true`, `skipLibCheck: true`
- `forceConsistentCasingInFileNames: true`
- Output: `backend/dist/`
- Target: ES2022, Module: ESNext, JSX: react-jsx
- `strict: true` enabled
- `isolatedModules: true`, `noEmit: true` (Vite handles bundling)
- `moduleResolution: bundler`
## Naming Patterns
- Backend: camelCase for all `.ts` files (`signalParser.ts`, `signalTracker.ts`, `dailyBreakoutEngine.ts`)
- Frontend pages: PascalCase (`Signals.tsx`, `Trades.tsx`, `BreakoutPaper.tsx`, `Calculator.tsx`, `Login.tsx`)
- Frontend components: PascalCase (`SignalTable.tsx`, `SignalBadge.tsx`, `SignalChart.tsx`, `Navbar.tsx`)
- Frontend API: camelCase (`client.ts`)
- camelCase for all functions: `fetchOHLCV()`, `computeIndicators()`, `parseSignalMessage()`
- Export functions directly with `export function` or `export async function`
- React components: PascalCase function names (`SignalModal`, `ScoreBadge`, `StatusBadge`)
- Private/internal helpers: camelCase, not exported (`round2()`, `computeMACD()`)
- camelCase: `symbolsCache`, `authToken`
- Constants (module-level arrays/objects): UPPER_SNAKE_CASE (`CHANNELS`, `NEAR512_CHANNELS`, `CACHE_TTL`)
- PascalCase, no `I` prefix: `CoinIndicators`, `ParsedSignal`, `MarketOverview`
- Use `interface` (not `type`) for object shapes
- Use `type` only for union types in function parameters (e.g., `'LONG' | 'SHORT'`)
- PascalCase model names: `Signal`, `Trade`, `BreakoutSignal`, `BreakoutPaperTrade`
- camelCase field names: `entryMin`, `stopLoss`, `takeProfits`, `closedPct`
## Code Style
- No Prettier or ESLint configured in the project
- Indent: 2 spaces
- Semicolons: omitted in most backend code, omitted in frontend code (no-semicolons style)
- Quotes: single quotes for strings
- Trailing commas: used in multi-line objects and arrays
- Line length: no enforced limit, generally kept under ~120 chars
- No ESLint, Prettier, Biome, or any linting tool configured
- TypeScript compiler (`tsc`) is the sole quality gate
## Import Organization
- Relative paths throughout: `../db/prisma`, `./market`, `../services/fundingRate`
- No path aliases configured (no `@/` or `~/`)
- Backend uses CommonJS output (`module: commonjs` in tsconfig)
- Frontend uses ES modules (`module: ESNext`, Vite bundler)
- Backend routes: `export default router` (default export for Express routers)
- Backend services: Named exports for functions and interfaces (`export function`, `export interface`)
- Frontend API: Named exports for all functions and interfaces in `frontend/src/api/client.ts`
- Frontend components: `export default function ComponentName()` (default export)
- Frontend pages: `export default function PageName()` (default export)
## Error Handling
- All route handlers wrapped in try/catch
- Errors typed as `any` (not `unknown`)
- Error response: `{ error: string }` consistently
- Logging with module prefix: `[Signals]`, `[SignalTracker]`, `[BreakoutLive]`, `[BreakoutPaper]`
- Services throw errors (not caught internally): `throw new Error('Symbol not found')`
- External API calls use fallback defaults on failure (e.g., `fetchMarketOverview()` returns safe defaults)
- Empty `catch` blocks used for non-critical failures (e.g., exchange fallbacks)
- Check `res.ok`, parse error body, throw Error
- Some functions silently return empty/default on failure (e.g., `searchSymbols` returns `[]`)
## API Response Formats
- `200` for all successful responses (no 201 for creation)
- `400` for invalid input
- `401` for unauthorized
- `404` for not found
- `409` for conflict (e.g. operation already running)
- `500` for server errors
## State Management (Frontend)
- `useState` for data, loading, and error states
- `useEffect` for initial data loading
- Manual refetch by calling fetch functions again
- No caching layer, no SWR/React Query
- Token stored in `localStorage` key `auth_token`
- Module-level `authToken` variable in `frontend/src/api/client.ts`
- `setAuthToken()` called on login/mount to sync
- Local state within components (no lifting except auth in `App.tsx`)
- Forms use individual `useState` for each field
- Modal visibility controlled by `useState<boolean>` or `useState<Item | null>`
## Database Access Patterns
- Single instance exported from `backend/src/db/prisma.ts`
- Imported as `import { prisma } from '../db/prisma'`
- `prisma.model.findMany({ where, orderBy, skip, take })` for paginated lists
- `prisma.model.findUnique({ where: { id } })` for single item
- `prisma.model.upsert({ where, create, update: {} })` for idempotent inserts
- `prisma.model.update({ where, data })` for mutations
- `prisma.model.count({ where })` alongside findMany for pagination totals
- `Promise.all([findMany, count])` pattern for parallel data + count
- Dynamic where built as `any` object (not typed)
## Authentication Pattern
- Middleware checks `X-Api-Secret` header against `process.env.API_SECRET`
- Applied to all `/api/*` routes except `/api/login`
- Login endpoint: POST `/api/login` with `{ password }` body, returns `{ token }` which is the API_SECRET itself
- All requests include `X-Api-Secret` header via `getHeaders()` helper
- Token set via `setAuthToken()` on login and page load
## Tailwind CSS Usage
- Custom colors: `primary`, `card`, `input`, `accent`, `long`, `short`, `neutral`, `text-primary`, `text-secondary`
- Custom fonts: `font-sans` (IBM Plex Sans), `font-mono` (JetBrains Mono)
- Inline Tailwind classes directly on JSX elements
- No CSS modules or styled-components
- Dynamic classes via template literals: `` `text-${signal.type === 'LONG' ? 'long' : 'short'}` ``
- Color mapping objects for status badges (defined inline in components)
## Logging
- Module-prefixed messages: `console.log('[BreakoutLive] Detected breakout...')`
- Error logging: `console.error('[ModuleName] Error:', err)`
- Warning for degraded service: `console.warn('Fear&Greed API unavailable, using defaults')`
## Comments
- Block comments for section headers in large files: `// === Phase 1: Gather market data ===`
- Inline comments for non-obvious logic: `// 4h candles: 6 = 24h`
- JSDoc-style on some functions (rare): `/** Auto-resolve the correct MEXC symbol */`
- Russian language used in comments: `// Кэш символов с биржи`
## Localization
- Date format: `ru-RU` locale consistently
- Status labels defined inline in components as Russian strings
- Comments: Mix of English and Russian
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## Pattern Overview
- Express REST API backend with route-service-DB layering
- React SPA frontend with page-level state management (no global store)
- PostgreSQL via Prisma ORM for persistence
- Functional modules: Signals (Telegram), Trades (manual journal), Daily Breakout (automated strategy), Forex Scanner, Calculator
- Background timers for signal tracking and breakout live/paper trading (in-process, not external scheduler)
- Password-based auth returning API secret token; all API routes protected by `X-Api-Secret` header
## Layers
- Purpose: HTTP endpoint definitions, request validation, response formatting
- Location: `backend/src/routes/`
- Contains: Express Router definitions for each module
- Depends on: Services, Prisma client
- Used by: Frontend via REST API
- Purpose: External API calls, data transformation, business logic
- Location: `backend/src/services/`
- Contains: Market data fetching, technical indicators computation, Telegram integration, signal parsing/tracking, Daily Breakout live + paper trader
- Depends on: External APIs (Bybit, Binance, MEXC, CoinGecko), Telegram MTProto
- Used by: Routes
- Purpose: Daily Breakout automated strategy
- Location: `backend/src/scalper/dailyBreakoutEngine.ts` + `services/dailyBreakoutLiveScanner.ts` + `services/dailyBreakoutPaperTrader.ts`
- Contains: 3h range detection, vol×2.0 confirmation, full trailing TP1→BE/TP2→TP1, splits 50/30/20
- Depends on: Services (market, indicators), Prisma
- Purpose: Backtest infrastructure
- Location: `backend/src/scalper/` (40+ scripts)
- Contains: Historical loader (Bybit/Binance kline cache), various walk-forward backtest runners for breakout/levels/forex/etc.
- Purpose: Prisma client singleton
- Location: `backend/src/db/prisma.ts`
- Contains: Single `PrismaClient` instance export
- Used by: All routes and services
- Purpose: Authentication
- Location: `backend/src/middleware/auth.ts`
- Contains: `X-Api-Secret` header check against `API_SECRET` env var
- Applied to: All `/api/*` routes (except `/api/login`)
- Purpose: UI views, each page manages its own state
- Location: `frontend/src/pages/`
- Contains: Full page components with inline sub-components
- Depends on: API client, shared components
- Key files:
- Purpose: Reusable UI elements
- Location: `frontend/src/components/`
- Key files:
- Purpose: Centralized HTTP layer
- Location: `frontend/src/api/client.ts`
- Contains: All API call functions, TypeScript interfaces for API responses, auth token management
- Pattern: Plain `fetch()` calls with shared `getHeaders()` for auth. No axios or query library.
## Data Flow
- No global state store (no Redux, Zustand, or Context providers)
- Each page manages its own state via `useState`/`useEffect`
- Auth token stored in `localStorage`, managed in `App.tsx` with `setAuthToken()` propagated to API client module-level variable
## Key Abstractions
- Purpose: Tracks trading signals parsed from Telegram channels
- Model: `Signal` in `backend/prisma/schema.prisma`
- Status lifecycle: `ENTRY_WAIT` -> `ACTIVE` -> `TP1_HIT`/`TP2_HIT`/.../`SL_HIT`
- Tracking: Automated via `signalTracker.ts` with trailing SL (after TP1: SL moves to entry; after TPn: SL moves to TP(n-1))
- Purpose: Daily Breakout automated trading signals
- Model: `BreakoutSignal` (live) + `BreakoutPaperTrade` (paper sim) in `backend/prisma/schema.prisma`
- Status lifecycle: `NEW` -> `TRIGGERED` -> `TP1_HIT`/`TP2_HIT`/`TP3_HIT`/`SL_HIT`/`EXPIRED`
- Tracking: Automated via `dailyBreakoutPaperTrader.ts`, single source of truth (no separate tracker cron)
- Purpose: User's manual trade log with P&L tracking
- Model: `Trade` in `backend/prisma/schema.prisma`
- Status lifecycle: `OPEN` -> `PARTIALLY_CLOSED`/`CLOSED`/`SL_HIT`/`CANCELLED`
- P&L: `amount` = margin, leverage applied to P&L calculation
- Purpose: Technical indicators across 3 timeframes (15m, 1h, 4h)
- Defined in: `backend/src/services/indicators.ts`
- Contains: ~30 indicators per timeframe (EMA, RSI, MACD, BB, Stoch, ADX, ATR, VWAP, Fibonacci, Pivots, candlestick patterns)
## Entry Points
- Location: `backend/src/index.ts`
- Starts Express server on `PORT` (default 3001)
- Registers routes, auth middleware, login endpoint
- Sets up `setInterval` timers: signal tracking (1h), integrity monitoring (15m), position reconcile (60s), TTL checker (60s)
- Starts Daily Breakout live scanner + paper trader on boot
- Production: `backend/dist/index.js` run via PM2
- Location: `frontend/src/main.tsx` -> `frontend/src/App.tsx`
- React 18 with `createRoot`, wrapped in `StrictMode`
- `App.tsx` handles auth gate: shows `Login` if no token, otherwise renders `BrowserRouter` with routes
- Routes: `/` and `/signals` -> Signals, `/breakout` -> BreakoutPaper, `/trades` -> Trades, `/scanner-forex` -> Forex, `/calculator` -> Calculator
- Location: `backend/src/telegram-auth.ts`
- Interactive script: `npx tsx src/telegram-auth.ts`
- Saves session to `backend/.telegram-session`
## Error Handling
- Routes: `try/catch` wrapping entire handler, returns `{ error: err.message }` with 500 status
- External API calls: `try/catch` with fallback values (e.g., `fetchMarketOverview` uses defaults if APIs fail)
- Market data: Bybit-first with Binance/MEXC fallback in `fetchOHLCV()`
- Daily Breakout: Continues on per-coin errors, logs warnings, never crashes the live scanner loop
- Signal tracker: Per-signal `try/catch`, logs error, continues to next signal
- Frontend: Silent `catch {}` in many places (no user-facing error for non-critical operations)
## Cross-Cutting Concerns
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
