# Requirements — v3.0 Code Quality & Security Hardening

## Security

- [x] **SEC-01**: Auth token убран из query параметров — только header X-Api-Secret, SSE использует альтернативный механизм (не query param)
- [x] **SEC-02**: Все JSON.parse вызовы обёрнуты в try-catch с fallback значениями — малформед данные не крашат приложение
- [x] **SEC-03**: CSV экспорт экранирует опасные символы (=, +, @, -) в начале полей — предотвращение CSV injection
- [x] **SEC-04**: POST /api/login имеет rate limiting — не более 5 попыток в минуту с одного IP

## Data Integrity

- [x] **DATA-01**: Multi-step DB операции (deleteMany+create, position update+TP placement) обёрнуты в prisma.$transaction
- [ ] **DATA-02**: Graceful shutdown — prisma.$disconnect(), очистка setInterval таймеров, корректное завершение WS соединений при SIGTERM/SIGINT
- [ ] **DATA-03**: DB индексы добавлены на Trade.status, Trade.coin, GeneratedSignal.status, GeneratedSignal.coin, Position.entryOrderId, Position.signalId
- [x] **DATA-04**: N+1 запрос в scannerTracker заменён на batch update — не выполнять prisma.trade.update в цикле

## Frontend Resilience

- [ ] **FE-01**: Пустые catch {} блоки заменены на console.error с контекстом ошибки, критичные операции показывают ошибку пользователю
- [ ] **FE-02**: Polling запросы используют AbortController для отмены при unmount/re-render, API client имеет consistent error handling
- [ ] **FE-03**: Ключевые any типы заменены на typed interfaces (indicators, marketContext, closes, where-объекты)
- [ ] **FE-04**: Дублирование polling баланса устранено — Navbar и страницы используют shared state через React Context

## Traceability

| REQ | Phase | Status |
|-----|-------|--------|
| SEC-01 | Phase 10 | Complete |
| SEC-02 | Phase 10 | Complete |
| SEC-03 | Phase 10 | Complete |
| SEC-04 | Phase 10 | Complete |
| DATA-01 | Phase 11 | Complete |
| DATA-02 | Phase 11 | Pending |
| DATA-03 | Phase 11 | Pending |
| DATA-04 | Phase 11 | Complete |
| FE-01 | Phase 12 | Pending |
| FE-02 | Phase 12 | Pending |
| FE-03 | Phase 12 | Pending |
| FE-04 | Phase 12 | Pending |

## Future Requirements

(None)

## Out of Scope

- **Float→Decimal migration** — требует миграцию всех данных, слишком рискованно для hardening milestone
- **Prisma enums вместо String status** — требует миграцию + рефакторинг всех where-запросов
- **Cascade rules на FK** — нужен анализ всех deletion flows, отложено
- **Request validation middleware (zod)** — добавляет зависимость и требует рефакторинг всех роутов
