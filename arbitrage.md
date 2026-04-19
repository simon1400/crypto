Нужно спроектировать и реализовать НОВЫЙ ОТДЕЛЬНЫЙ МОДУЛЬ.

ВАЖНО:
- Не ломай существующий модуль сканера сигналов на фьючерсы.
- Не переписывай рабочую архитектуру без необходимости.
- Новый модуль должен быть полностью отдельным функциональным разделом.
- Он должен быть встроен как НОВАЯ ВКЛАДКА В ВЕРХНЕМ МЕНЮ приложения.
- Название новой вкладки: АРБИТРАЖ.
- Сначала проанализируй текущую структуру проекта, текущий UI, роутинг, Bybit API слой, backend, Prisma models, state management и reusable components.
- Потом предложи краткий implementation plan.
- Потом реализуй код.
- Если есть 1-2 действительно критичных вопроса — задай их. Во всех остальных случаях принимай решения сам по текущему коду проекта.

==================================================
КОНТЕКСТ ПРОЕКТА
==================================================

Это уже существующая торговая веб-аппка.
Сейчас в ней есть:
- рабочий сканер сигналов по фьючерсам
- подключенный Bybit API
- backend
- database
- Prisma
- существующая логика по депозиту и риску
- темный UI с карточками, бейджами, score и фильтрами
- всю детальную информацию по архитектуре и коду можешь сразу посмотреть в папке .planning

Нужно добавить новый модуль как отдельную вкладку верхнего меню:
АРБИТРАЖ

Этот модуль должен быть нативно встроен в текущую архитектуру и визуальный стиль.

==================================================
ЦЕЛЬ НОВОГО МОДУЛЯ
==================================================

Новый модуль должен анализировать market-neutral / carry / arbitrage возможности, а не обычные directional сигналы.

Нужно реализовать два направления анализа:

1. Funding Arbitrage Scanner
2. Basis Trade Scanner

Модуль должен:
- запускаться вручную
- использовать Bybit API через уже существующий data layer проекта
- анализировать whitelist ликвидных монет
- учитывать депозит и риск пользователя
- выдавать список найденных возможностей
- показывать score, status, confidence, risk flags
- показывать расчет ожидаемой net доходности
- строить execution plan
- сохранять scan history в БД
- иметь отдельный подтаб для истории
- иметь action buttons на карточках
- НЕ открывать реальные сделки (ето все сделаем потом)
- НЕ ставить реальные ордера (ето все сделаем потом)
- НЕ быть auto-trading модулем (ето все сделаем потом)

==================================================
КЛЮЧЕВЫЕ РЕШЕНИЯ
==================================================

Фиксированные продуктовые решения:

1. Новый модуль = отдельная вкладка верхнего меню: АРБИТРАЖ
2. Результаты показывать КАРТОЧКАМИ как в сканере сигналов
3. Историю показывать отдельным ПОДТАБОМ внутри модуля Арбитраж
4. Кнопка "Подготовить план" должна не просто открывать детали, а:
   - генерировать structured execution plan
   - сохранять его в БД
   - позволять потом открыть этот план повторно
5. Сканирование пока только РУЧНОЕ
6. Для анализа использовать whitelist ликвидных монет как основной режим
7. Нужно учитывать депозит и риск пользователя
8. Нужно сохранять историю сканов
9. Нужно реализовать сразу Funding + Basis, с фильтрами по типу стратегии

==================================================
HIGH-LEVEL PRODUCT FLOW
==================================================

Пользователь:
1. Открывает вкладку Арбитраж
2. Видит control panel
3. Видит текущие настройки депозита и риска (уже есть в сканере)
4. Запускает сканирование кнопкой
5. Модуль анализирует whitelist ликвидных инструментов
6. Показывает найденные opportunities карточками
7. Пользователь открывает детали карточки
8. Может:
   - подготовить план
   - скопировать сетап
   - сохранить кандидата
   - перейти в историю
9. В подтабе История пользователь видит прошлые сканы и сохраненные планы

==================================================
СТРАТЕГИИ ДЛЯ АНАЛИЗА
==================================================

------------------------------------------
1. FUNDING ARBITRAGE
------------------------------------------

Основной production-ready сценарий:
BUY SPOT + SHORT PERP

Идея:
если funding устойчиво положительный, то long-позиции платят short-позициям,
значит возможна delta-neutral конструкция:
- покупка spot
- шорт perpetual

Что нужно анализировать:
- current funding rate
- next/predicted funding if available
- funding history last N intervals
- funding persistence
- funding stability
- premium/mark/index behavior if available
- open interest
- volume
- spread
- fees
- slippage
- net expected yield
- suitability under current deposit

Обратный сценарий:
SHORT SPOT / MARGIN SPOT + LONG PERP
не нужно делать основной production path, но можно предусмотреть архитектурно как future extension.

------------------------------------------
2. BASIS TRADE
------------------------------------------

Основной production-ready сценарий:
BUY SPOT + SHORT FUTURES

Идея:
если expiry futures торгуется с премией к spot,
то можно захеджировать направление и ждать схлопывания basis к expiry.

Что нужно анализировать:
- spot price
- futures price
- basis absolute
- basis percent
- days to expiry
- annualized basis
- net annualized basis after fees/slippage
- liquidity
- spread
- execution suitability

==================================================
UNIVERSE / WHITELIST
==================================================

Для нового модуля НЕ нужно по умолчанию сканировать все 606 фьючерсных инструментов.

Нужно сделать:
- whitelist ликвидных инструментов как основной режим
- архитектурную возможность расширения whitelist
- future capability для full scan, но не как дефолт

Whitelist должен состоять из монет, которые реально подходят для:
- spot + perp hedging
- spot + futures basis
- приемлемой ликвидности
- узких спредов
- нормального объема

Реализация whitelist:
- если в проекте уже есть конфиг universe — используй его
- если нет — создай server-side configurable whitelist
- желательно сделать его расширяемым через БД/конфиг

Также:
- при необходимости добавь логику загрузки актуального списка spot instruments
- корректно матчь spot/perp/futures инструменты между собой

==================================================
СТРУКТУРА UI
==================================================

Модуль Арбитраж должен выглядеть как родная часть текущего приложения.

Визуальный стиль:
- темная тема
- карточки
- компактные цветные бейджи
- score в заметной зоне
- плотный desktop-first layout
- стиль максимально близок к текущему сканеру сигналов

Нужна одна основная вкладка Арбитраж с подтабами, например:
- Возможности
- История
- Планы

Если по текущему UI лучше сделать:
- Возможности
- История
а планы встроить в историю/кандидаты,
то допускается такой вариант.
Но как минимум отдельный подтаб История обязателен.

==================================================
ПОДТАБЫ ВНУТРИ ВКЛАДКИ АРБИТРАЖ
==================================================

Минимально реализовать подтабы:

1. Возможности
- текущий scan UI
- control panel
- summary
- результаты карточками

2. История
- список прошлых scan runs
- возможность открыть результаты конкретного scan run
- saved candidates / saved plans
- сохраненные execution plans

Если логика проекта позволяет удобно разделить:
- История
- Планы
то это допустимо.
Но минимум должен быть отдельный подтаб История.

==================================================
CONTROL PANEL
==================================================

В подтабе Возможности сделать control panel.

Обязательно:
- selector strategy mode:
  [All] [Funding] [Basis]
- кнопка "Сканировать"
- поиск по символу
- min score
- min expected net APR
- min liquidity
- min volume
- min OI
- max spread
- only executable
- only high confidence
- whitelist only
- show saved only optional
- сортировка

Также нужно использовать/переиспользовать существующую логику депозита и риска:
- депозит
- риск %
- возможно max capital allocation per setup
- если в текущем сигнал-сканере это уже есть — подтяни тот же UX паттерн

==================================================
SUMMARY BLOCK
==================================================

После сканирования нужно показать summary block.

Показывать:
- last scan time
- checked instruments count
- found opportunities count
- funding opportunities count
- basis opportunities count
- strong opportunities count
- executable opportunities count
- best annualized net
- average score

==================================================
RESULTS AREA
==================================================

Результаты показывать КАРТОЧКАМИ.

Каждая карточка должна быстро давать понять:
- symbol
- strategy type
- direction
- status
- score
- confidence
- risk level
- ключевую net доходность
- риск-флаги

Карточка должна быть похожа по читаемости и плотности на карточки текущего сканера сигналов.

На карточке нужно показывать:

Общее:
- Symbol
- Strategy type: Funding / Basis
- Direction
- Status
- Score
- Confidence
- Risk level
- Scanned at

Funding-specific:
- Current funding
- Predicted funding if available
- Funding persistence
- Gross expected yield
- Net expected yield
- Annualized net
- Next funding time
- OI
- Volume
- Spread

Basis-specific:
- Spot price
- Futures price
- Basis abs
- Basis %
- Annualized basis
- Net annualized basis
- Days to expiry
- Expiry time
- OI
- Volume
- Spread

==================================================
DETAIL EXPANSION / CARD DETAILS
==================================================

У карточки должен быть detail expansion / detail panel / expand section без перехода на отдельную страницу.

В деталях показать:
- Symbol
- Strategy
- Trade construction
- Status
- Score
- Score breakdown
- Confidence
- Risk level
- Explanation bullets
- Risk flags
- Core metrics
- Fees assumption
- Slippage assumption
- Holding horizon
- Recommended execution style
- Max recommended size
- Size constraint reason
- Suitability for current deposit
- Warnings
- Raw/debug metrics optional collapsible

==================================================
ACTION BUTTONS НА КАРТОЧКЕ
==================================================

На каждой карточке реализовать action buttons:

1. Подготовить план
Функция:
- генерирует structured execution plan
- сохраняет его в БД
- связывает его с найденной opportunity
- делает план доступным из подтаба История или Планы

2. Скопировать сетап
Копирует короткий текст/structured summary:
- symbol
- strategy
- direction
- score
- expected net APR
- key risk flags
- short execution note

3. Сохранить кандидата
Сохраняет opportunity в shortlist / favorites / candidates

4. Открыть детали
Если detail panel уже открыт inline, можно заменить на:
- Показать детали / Скрыть детали

Можно также сделать:
5. Открыть план
Если для opportunity уже создан execution plan

НЕ реализовывать:
- Place order
- Auto execute
- Real order actions

==================================================
УЧЕТ ДЕПОЗИТА И РИСКА
==================================================

Это обязательная часть.

Модуль должен учитывать:
- депозит пользователя
- риск %
- возможно max allocation per setup
- suitability for current balance

Нужно использовать ту же логику UX, что уже есть в текущем сканере сигналов, если это возможно.

По каждому сетапу рассчитывать:
- suggested capital allocation
- max recommended size
- size limitation reason
- execution suitability under current deposit

Например:
- Deposit: 769
- Risk: 2%
- Suggested size: X
- Max recommended size: Y
- Estimated fees: ...
- Estimated slippage: ...
- Suitability: good / limited / inefficient due to size

Размер можно оценивать по:
- liquidity
- spread
- volume
- slippage threshold
- если уже есть orderbook depth layer — используй его
- если нет — реализуй эвристику на liquidity/spread/volume

==================================================
МАТЕМАТИКА И РАСЧЕТЫ
==================================================

Сделай аккуратный аналитический слой с четким разделением логики.

------------------------------------------
A. FUNDING CALCULATIONS
------------------------------------------

Нужно рассчитывать:

1. funding_mean_last_n
2. funding_std_last_n
3. funding_persistence
4. premium_persistence if possible
5. gross_yield_1d
6. net_yield_1d
7. gross_yield_3d
8. net_yield_3d
9. gross_yield_7d
10. net_yield_7d
11. annualized_net_yield

Базовые формулы:
net_expected_yield =
  gross_expected_yield
  - fee_drag
  - slippage_drag
  - other_costs if any

annualized_net_yield =
  net_expected_yield / holding_days * 365

Funding persistence:
- считать как долю интервалов, где funding сохранялся в нужную сторону
- например 7/8 positive

Если historical depth недостаточен:
- не падать
- ставить risk flag low_history_depth
- снижать confidence
- показывать explanation почему confidence ниже

------------------------------------------
B. BASIS CALCULATIONS
------------------------------------------

Нужно рассчитывать:

basis_abs = futures_price - spot_price
basis_pct = basis_abs / spot_price
days_to_expiry = (expiry - now) in days

annualized_basis = basis_pct * 365 / days_to_expiry

net_annualized_basis =
  annualized_basis
  - fees
  - slippage
  - carry_costs_if_any

Если Bybit API отдает:
- basis
- basisRate
- basisRateYear
используй это тоже.

Если возможно:
- пересчитывай вручную
- если есть заметное расхождение, показывай warning/debug note

==================================================
SCORING SYSTEM
==================================================

Нужна расширяемая scoring system 0..100.

Все веса вынести в конфигируемое место.

------------------------------------------
Funding scoring:
------------------------------------------

score =
  30% * yield_score
+ 20% * persistence_score
+ 15% * liquidity_score
+ 15% * spread_score
+ 10% * oi_stability_score
+ 10% * fee_efficiency_score

------------------------------------------
Basis scoring:
------------------------------------------

score =
  35% * annualized_return_score
+ 20% * liquidity_score
+ 15% * spread_score
+ 15% * time_to_expiry_score
+ 10% * fee_efficiency_score
+ 5% * stability_score

Нужно:
- отдельные sub-score functions
- normalized sub-scores 0..100
- общий score 0..100
- score breakdown для UI

Статусы:
- SKIP
- WATCHLIST
- GOOD
- STRONG
- EXECUTABLE

Сделать configurable thresholds.
Пример:
- 0-49 = SKIP
- 50-64 = WATCHLIST
- 65-79 = GOOD
- 80-89 = STRONG
- 90+ = EXECUTABLE

==================================================
CONFIDENCE / RISK / FLAGS
==================================================

Нужно рассчитывать:
- confidence
- risk level
- risk flags

Примеры risk flags:
- low_liquidity
- wide_spread
- unstable_funding
- low_history_depth
- funding_flip_risk
- near_expiry
- high_slippage
- low_volume
- inconsistent_basis
- insufficient_confidence
- spot_pair_missing
- futures_pair_missing

Показывать их:
- кратко на карточке
- подробно в деталях

==================================================
EXECUTION PLAN
==================================================

По каждой найденной opportunity нужно уметь строить execution plan.

Execution plan должен включать:
- symbol
- strategy
- trade construction
- preferred execution mode
- recommended size
- max recommended size
- size constraint reason
- fee estimate
- slippage estimate
- ideal conditions
- avoid conditions
- execution notes
- hedge notes
- warnings
- snapshot of metrics at plan creation time

Примеры:
- BUY SPOT + SHORT PERP
- BUY SPOT + SHORT FUTURES
- maker-first
- avoid if spread > X
- avoid if predicted funding drops below Y
- avoid if days to expiry < threshold
- max recommended size based on current liquidity

Кнопка "Подготовить план" должна:
- создавать ExecutionPlan record в БД
- связывать его с opportunity
- позволять открыть этот план позже в Истории

==================================================
ОБЪЯСНИМОСТЬ АНАЛИЗА
==================================================

Это критично.

Для каждого результата пользователь должен понимать:
- почему сетап найден
- почему score высокий/низкий
- какие риски есть
- какие assumptions использованы

Вывести:
- explanation bullets
- score breakdown
- warnings
- assumptions
- optional debug/raw metrics section

Примеры explanation:
- Positive funding persisted in 6 of last 8 intervals
- Liquidity acceptable for current deposit size
- Spread remains within configured threshold
- Net annualized return remains attractive after estimated fees
- Confidence reduced because historical depth is limited

==================================================
ИСТОРИЯ / ПОДТАБ ИСТОРИЯ
==================================================

Отдельный подтаб История обязателен.

Там нужно показывать:
- прошлые scan runs
- summary по каждому scan run
- возможность открыть результаты конкретного scan run
- сохраненные candidates
- сохраненные execution plans

История должна быть сохранена через Prisma.

==================================================
PRISMA / DB MODELS
==================================================

Нужно продумать и реализовать Prisma models.

Минимально нужны сущности:

1. ArbitrageScanRun
Поля типа:
- id
- createdAt
- scanType
- checkedCount
- foundCount
- fundingCount
- basisCount
- executableCount
- bestAnnualizedNet
- avgScore
- filtersSnapshot
- depositSnapshot
- riskSnapshot

2. ArbitrageOpportunity
Поля типа:
- id
- scanRunId
- symbol
- baseAsset
- quoteAsset
- strategyType
- direction
- status
- score
- confidence
- riskLevel
- currentFundingRate
- predictedFundingRate
- fundingMean
- fundingStd
- fundingPersistence
- premiumPersistence
- spotPrice
- perpPrice
- futuresPrice
- basisAbs
- basisPct
- annualizedGross
- annualizedNet
- grossYield1d
- netYield1d
- grossYield3d
- netYield3d
- grossYield7d
- netYield7d
- spreadPct
- volume24h
- openInterest
- daysToExpiry
- expiryTime
- feesEstimate
- slippageEstimate
- executionMode
- maxRecommendedSize
- suitabilityForDeposit
- riskFlags
- scoreBreakdown
- explanation
- debugMeta
- createdAt

3. SavedArbitrageCandidate
Поля типа:
- id
- opportunityId or snapshot
- savedAt
- notes optional
- isFavorite
- tags optional

4. ArbitrageExecutionPlan
Поля типа:
- id
- opportunityId
- createdAt
- symbol
- strategyType
- direction
- planStatus
- tradeConstruction
- preferredExecutionMode
- recommendedSize
- maxRecommendedSize
- feeEstimate
- slippageEstimate
- executionNotes
- avoidConditions
- idealConditions
- warnings
- metricsSnapshot
- userDepositSnapshot
- userRiskSnapshot

Сделай типы и JSON-поля в стиле текущего проекта.

==================================================
АРХИТЕКТУРНОЕ РАЗДЕЛЕНИЕ
==================================================

Реализуй новый модуль аккуратно слоями:

1. Data source layer
- использовать existing Bybit client
- расширить при необходимости

2. Normalization layer
- нормализовать spot/perp/futures data в единый internal format

3. Analytics layer
- funding analyzer
- basis analyzer
- scoring
- confidence
- risk flags
- execution planner
- suitability under deposit

4. Persistence layer
- Prisma models
- saving scan runs
- saving opportunities
- saving execution plans
- saving candidates

5. UI layer
- новая вкладка верхнего меню
- подтабы
- control panel
- summary
- result cards
- detail expansion
- history UI

==================================================
INTERNAL DATA MODEL
==================================================

Сделай строгие типы для internal domain models.

Пример internal model:

ArbitrageOpportunityDomainModel:
- id
- scannedAt
- symbol
- baseAsset
- quoteAsset
- marketType
- strategyType: "funding" | "basis"
- direction
- status
- score
- confidence
- riskLevel
- currentFundingRate?
- predictedFundingRate?
- fundingMean?
- fundingStd?
- fundingPersistence?
- premiumPersistence?
- spotPrice?
- perpPrice?
- futuresPrice?
- basisAbs?
- basisPct?
- annualizedGross?
- annualizedNet?
- grossYield1d?
- netYield1d?
- grossYield3d?
- netYield3d?
- grossYield7d?
- netYield7d?
- spreadPct?
- volume24h?
- openInterest?
- daysToExpiry?
- expiryTime?
- feesEstimate?
- slippageEstimate?
- executionMode?
- recommendedSize?
- maxRecommendedSize?
- suitabilityForDeposit?
- riskFlags[]
- scoreBreakdown
- explanation[]
- debugMeta?

==================================================
SCAN FLOW
==================================================

Нужен понятный end-to-end scan flow:

1. Пользователь открывает вкладку Арбитраж
2. Видит подтаб Возможности
3. Видит control panel
4. Видит/редактирует депозит и риск
5. Нажимает "Сканировать"
6. Запускается backend scan flow
7. Получаются market data from Bybit
8. Идет normalization
9. Идет funding analysis
10. Идет basis analysis
11. Формируются opportunities
12. Рассчитываются score, confidence, risk flags
13. Сохраняется ArbitrageScanRun
14. Сохраняются ArbitrageOpportunity records
15. UI показывает result cards
16. Пользователь может подготовить execution plan или сохранить кандидата
17. Пользователь может открыть подтаб История и посмотреть прошлые scan runs и планы

==================================================
ФИЛЬТРЫ И СОРТИРОВКИ
==================================================

Добавь фильтры:
- strategy type
- status
- symbol search
- min score
- min annualized net
- max spread
- min volume
- min OI
- only executable
- only high confidence
- whitelist only

Добавь сортировки:
- score
- annualized net
- confidence
- liquidity
- funding rate
- basis %
- expiry
- scanned time

==================================================
ПРОИЗВОДИТЕЛЬНОСТЬ
==================================================

Сканер должен быть разумно эффективным.

Нужно:
- ограничить concurrency запросов
- использовать batch fetching where possible
- использовать existing caching patterns
- корректно обрабатывать partial failures
- не блокировать UI
- не делать чрезмерно тяжелый full scan by default

По умолчанию:
- whitelist mode

==================================================
ОБРАБОТКА ОШИБОК
==================================================

Нужно:
- не падать при неполных данных
- gracefully skip missing pairs
- логировать причины skip
- показывать user-friendly ошибки
- partial failure не должен ломать весь scan

==================================================
UI/UX ДОПОЛНИТЕЛЬНЫЕ ТРЕБОВАНИЯ
==================================================

Хочу, чтобы новый модуль визуально был похож на текущий сканер сигналов:
- плотный практичный интерфейс
- карточки
- цветные бейджи
- понятные score и статусы
- быстрый визуальный обзор

Хочу быстро видеть на карточке:
- symbol
- strategy
- direction
- status
- score
- annualized net
- confidence
- risk flags

Детали лучше раскрывать внутри того же экрана.

Если в проекте уже есть reusable:
- cards
- tabs
- badges
- tables
- dropdowns
- tooltips
- modal/sheet
- skeleton loading
то обязательно использовать их.

==================================================
MVP / PRODUCTION-LIKE DELIVERY
==================================================

Если весь scope слишком большой для одного прохода, разрешается сделать качественный production-like MVP.
Но такой MVP ОБЯЗАТЕЛЬНО должен включать:

- новая вкладка верхнего меню: Арбитраж
- подтабы минимум:
  - Возможности
  - История
- Funding scanner
- Basis scanner
- whitelist mode
- ручной scan
- учет депозита и риска
- score system
- result cards
- detail expansion
- action buttons:
  - Подготовить план
  - Скопировать сетап
  - Сохранить кандидата
- Prisma persistence:
  - scan runs
  - opportunities
  - execution plans
  - candidates
- просмотр последних scan results
- просмотр history

И архитектурно подготовить основу для:
- full universe scan
- автообновления
- orderbook-depth sizing
- future execution workflows

==================================================
ОГРАНИЧЕНИЯ
==================================================

НЕ делать:
- auto trading
- real order placement
- dangerous side effects
- дублирование existing Bybit client
- смешивание нового модуля со старым signal scanner

==================================================
ЧТО Я ОЖИДАЮ ОТ ТЕБЯ
==================================================

Работай строго в таком порядке:

1. Сначала проанализируй текущую кодовую базу и кратко опиши:
   - архитектуру проекта
   - куда встроится новая вкладка Арбитраж
   - какие файлы будут добавлены/изменены
   - какие Prisma модели будут добавлены
   - как будет устроен scan flow
   - как будет устроена история
   - как будет устроено создание execution plan

2. Затем предложи краткий implementation plan.

3. Затем реализуй код.

4. После реализации дай краткий changelog:
   - какие страницы добавлены
   - какие сервисы добавлены
   - какие prisma модели добавлены
   - какие backend routes/queries/actions добавлены
   - какие UI components добавлены
   - какие data models добавлены

5. Если нужны только 1-2 критичных уточнения — спроси коротко.
Иначе — принимай решения сам, по текущему проекту.

Начинай с анализа текущего проекта.