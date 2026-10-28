# StemPlayer — техническая документация

Внутреннее устройство: архитектура «ядро + модули», фоновые процессы, потоки данных, контракты API, ключевые решения и замечания по специфике Windows. Реализованы два модуля — «Обработка» (`analysis/`) и «Стемы» (`stemgen/`).

---

## 1. Общая архитектура

Три уровня, разделённых по зонам ответственности:

```
┌──────────────────────┐   HTTP (опрос)   ┌───────────────────────────┐
│  Фронтенд            │ ───────────────► │  API-слой модуля          │
│  analysis/assets/js  │ ◄─────────────── │  analysis/analysisApi.php │
│  (ESM, без сборки)   │   JSON раз в 2 с │  stemgen/stemgenApi.php   │
└──────────────────────┘                  └────────────┬──────────────┘
                                                          │ SpawnCli (proc_open, не ждём)
                                                          ▼
                                       ┌──────────────────────────────────────┐
                                       │  CLI-демон (отдельный php-процесс)   │
                                       │  analysis/cli/analyze_cli.php        │
                                       │  stemgen/cli/stems_cli.php           │
                                       │  stemgen/cli/cascade_cli.php         │
                                       └──────────────┬───────────────────────┘
                                                      │ PythonRunner (proc_open)
                                                      ▼
                            ┌──────────────────────────────┐   ┌───────────────────────────┐
                            │ analysis/scripts/analyzer.py  │   │ stemgen/scripts/          │
                            │ (librosa, numpy, mutagen)     │   │ stem_splitter.py          │
                            │ system python                 │   │ split_instrument.py       │
                            │                               │   │ (venv_demucs: demucs+cu)  │
                            └──────────────┬───────────────┘   └────────────┬──────────────┘
                                           │ пишут состояние                   │
                                           ▼                                   ▼
                        storage/progress.json          storage/stemgen_progress.json
                        storage/tracks.json            (раздельно, чтобы не мешать)
```

- **Фронтенд** — нативные ES-модули (`analysis`) и скрипты с неймспейсом `window.StemGen` (`stemgen`). Никакого bundler'а и сторонних зависимостей. Страницы работают по HTTP(S).
- **API** — у каждого модуля свой front-контроллер `{модуль}Api.php` с роутером `match($action)`. Бизнес-логика вынесена в классы каталога модуля; всё общее — в `core/`.
- **Ядро** (`core/`) — `Http` (JSON), `ProgressStore` (состояние), `RunState` (живость и блокировки), `PageGuard` (страницы), `SpawnCli` (фоновый процесс), `PythonRunner` (python), `FileLog` (журнал на диск).
- **Анализ** — внешний Python-процесс. PHP не декодирует аудио: вся DSP выполняется в `analyzer.py`.

### Принципиальные решения

1. **Фоновая работа не зависит от вкладки.** Запрос `start_analysis` поднимает отдельный CLI-демон (`SpawnCli`) и возвращает `{"status":"started"}` сразу. Страницу можно закрыть — работа продолжается; при повторном открытии прогресс подхватывается опросом.
2. **Прогресс — через файл, а не через pipe.** На Windows чтение пайпов дочернего процесса при долгих операциях может блокироваться. Поэтому состояние демона пишется в JSON-файл, который демон и веб-страница читают атомарно.
3. **Не передавать `$_SERVER` как окружение в `proc_open`.** На Windows передача `$_SERVER` искажает переменные среды дочернего процесса, поэтому окружение наследуется без принудительной передачи `env`.
4. **Атомарная запись состояния с защитой от коллизий.** `ProgressStore` пишет во временный файл с уникальным PID и токеном (`.pid.token.tmp`) и атомарно переименовывает его в целевой файл, исключая повреждение данных при параллельных вызовах.
5. **Серверная взаимная блокировка.** Страницы защищены `PageGuard` (редирект 302 на активный модуль), а API блокирует попытку параллельного запуска конкурирующего демона.
6. **Дискретная шкала этапов.** Анализ и Demucs работают фиксированными шагами. Вместо скачущих псевдопроцентов шкала трека разбита на равные сегменты по фактическому номеру этапа (`current_stage_index`).
7. **Кооперативная остановка с откатом.** Кнопка «Стоп» выставляет флаг `stop_requested`. Демон завершает процесс через `PythonRunner` (`taskkill /T`) и выполняет откат незавершённого трека (удаление созданных копий, частичных каталогов стемов и записей в базе).
8. **Независимый флаг остановки.** Запрос остановки с диска защищён от перезаписи устаревшим кэшем демона: метод `update()` при наличии `stop_requested` перечитывает файл с диска, сохраняя флаг.
9. **Явный путь к PHP из конфига.** Под Apache константы `PHP_BINARY` указывают на `httpd.exe`, поэтому путь к CLI-интерпретатору задаётся в `STEMPLAYER_PHP` (`config.php`).

---

## 2. Дерево проекта и назначение файлов

```
index.php              — хаб со списком модулей; закрыт, пока работает любой модуль
config.php             — автозагрузчик классов (core/, classes/), пути, интерпретаторы, константы
.htaccess              — upload_max_filesize 300M, post_max_size 310M, max_file_uploads 50, max_execution_time 0

core/                  — ядро, общее для всех модулей
  Http.php             — JSON-ответы с приведением к UTF-8
  ProgressStore.php    — состояние демона в progress.json: статус, счётчики, флаг стопа,
                         last_ping (сердцебиение), last_message (одна строка журнала), атомарная запись
  RunState.php         — «живость» демона по last_ping + взаимная блокировка модулей
  PageGuard.php        — серверная блокировка страниц (302 на активный модуль)
  SpawnCli.php         — запуск CLI-демона в фоне (proc_open, мимо httpd.exe) + tail лога
  PythonRunner.php     — запуск python через proc_open, неблокирующее чтение вывода, кооперативный стоп
  FileLog.php          — строчный журнал в logs/

analysis/              — модуль «Обработка»
  index.php            — страница модуля; первым делом PageGuard
  analysisApi.php      — роутер действий + функции-обработчики (start/get/upload/stop/delete)
  cli/analyze_cli.php  — фоновый демон: цикл по файлам inbox/
  assets/css/
    base.css           — :root переменные, reset, body, .app, @keyframes
    components.css     — header, .btn-*, progress-track (бегущая полоса),
                         dropzone, журнал-строка
    table.css          — тулбар, таблица, колонки, плеер, SVG-play, chips, @media
    Порядок подключения: base → components → table.
  assets/js/           — 11 нативных ES-модулей (без сборки):
    main.js            — точка входа
    store.js           — синглтон-состояние, ссылки на DOM-элементы, константы
    utils.js           — fetchJson, fmtDuration, logRunFinished, renderLogs, showProgress, buildNameNode
    player.js          — Audio-плеер в строках + очередь «Подряд»; play-иконка = SVG
    table.js           — renderTable, live-обновление строк, syncPlayButtons/syncDeleteButtons
    sort.js            — сортировка/перемешивание по колонкам
    views.js           — переключение вью (upload/tracks)
    upload.js          — загрузка multipart, refreshInbox
    analysis.js        — старт демона, опрос прогресса, восстановление зависшего прогона, стоп
    delete.js          — модалка подтверждения удаления, вызов delete_track
    core/eq.js, core/ui.js — общие модули: Stereo-EQ, контроллер навигации и строка журнала
  classes/
    AnalysisService.php — запуск analyzer.py через core/PythonRunner, разбор результата
    AnalysisRunner.php  — цикл демона по файлам (reset → проверка BPM → откат при стопе → финал)
    AnalysisInterface.php, SortingInterface.php — контракты
    TracksIndex.php     — кэш результатов в storage/tracks.json + сборка строк таблицы
    TrackCleaner.php    — удаление трека (Inbox, sorted, {id}/ со стемами, storage) с UTF-8 проверкой
    FileSorter.php      — перекладывание в music/sorted/, безопасные имена папок BPM*_Key*
    UploadService.php   — приём multipart-загрузки, санитизация имён, уникализация
  scripts/analyzer.py  — Python-анализатор BPM/Key/метаданных (librosa, numpy, mutagen)
  music/               — общий каталог: inbox/ (вход), sorted/ (результат)

stemgen/               — модуль «Стемы»
  index.php            — страница модуля; PageGuard + ?v= версии ассетов
  stemgenApi.php       — роутер действий (get_tracks/start_generation/split_instrument/get_progress/stop)
  cli/stems_cli.php    — фоновый демон: последовательная очередь Demucs
  cli/cascade_cli.php  — фоновый демон каскада: Other → guitar/piano (htdemucs_6s), очистка temp
  classes/
    StemGenInterface.php — контракт generateStems
    StemRegistry.php     — реестр music/sorted/ + hash-ID + безопасный resolve
    StemService.php      — вызов Demucs/каскада, верификация стемов, удаление исходника
    StemRunner.php       — очередь неразделённых треков (фильтрация готовых, откат прерванных)
  assets/
    css/stemgen.css     — стили каналов, уровнемеров и карточек поверх общих CSS
    js/                 — 17 скриптов в неймспейсе window.StemGen:
      app.js, core/{constants,dom,store,utils}.js,
      engine/{player,stem,track,waveform}.js,
      services/{api,download,generation,notifier}.js,
      ui/{channel,level-meter,spectrum,table}.js
  scripts/stem_splitter.py — Demucs (--mp3) → {ID}/{ID}_{stem}.mp3 + meta.json
  scripts/split_instrument.py — Demucs каскад: Other → {ID}/{ID}_guitar.mp3 + _piano.mp3
venv_demucs/           — виртуальное окружение Python (torch+CUDA, demucs 4.1)
storage/               — каталоги состояния (защищены от прямого веб-доступа через .htaccess)
  .htaccess            — Require all denied
  progress.json        — состояние демона «Обработка»
  tracks.json          — кэш результатов анализа
  stemgen_progress.json— состояние демона «Стемы»
  cascade_request.json — файл-дескриптор запроса каскада
  analysis_start.lock, stemgen_start.lock — блокировки запуска демонов
logs/                  — логи процессов (.htaccess: Require all denied)
```

Все пути в классах `__DIR__`-относительные. `storage/` и `music/` общие для всего проекта. Сборки JS нет: `tools/build.js` и `sorter.min.js` удалены как мёртвый код, страницы подключают исходники напрямую.

---

## 3. Взаимная блокировка модулей и «живость» демона

Модули делят GPU, диск и каталог `music/sorted/` — работать одновременно нельзя. Механизм трёхуровневый, единый источник истины — `core/RunState.php`.

### 3.1 Детект живого процесса

Демон считается работающим, если в его progress-файле `status = "running"` **и** состояние свежее (`RunState::isFresh`):

- есть `last_ping` (Unix-время последней записи) не старше **90 секунд**; или
- fallback для старых файлов: `started_at` не старше **30 минут**;
- нет ни того, ни другого → процесс мёртв, модуль считается свободным.

`last_ping` проставляется в `ProgressStore::write()` при **каждой** записи. Демон дополнительно зовёт `keepAlive()` (не чаще 1 раза в 10 с) из цикла ожидания, чтобы диск не трогать, но пульс держать: Demucs на трек считает минутами, и наивный детект по одному лишь обновлению статуса считал бы живой процесс мёртвым. TTL 90 с выбран с запасом именно на эту асимметрию.

Это лечит «залипание»: если демон упал, страницы открываются сами через ≤90 с, без ручной правки JSON.

### 3.2 Уровень API

- `start_analysis` / `start_generation`: если соседний демон жив → `{"status":"blocked","message":…}`.
- Параллельный запуск того же модуля дополнительно защищён `flock` на `storage/{module}_start.lock` — два окна не поднимут два демона.
- `get_progress` и `get_inbox` / `get_tracks` отдают флаг соседа (`stemgen_running` / `analysis_running`), поэтому фронтенд блокирует кнопки.

### 3.3 Уровень страниц — `PageGuard`

Пока сосед работает, страница модуля отвечает `302 Location: <страница активного модуля>`:

- `analysis/index.php` → `../stemgen/index.php`, если идёт генерация;
- `stemgen/index.php` → `../analysis/index.php`, если идёт обработка;
- `index.php` (хаб) → на страницу любого активного модуля.

`PageGuard::enforce($module, $relativeBase)` вызывается **первым** в каждом `index.php`, до вывода HTML. Если заголовки уже ушли (предупреждение PHP раньше по коду) — мягкий `409` с текстом. Так закрыты прямой URL, вторая вкладка и кнопка «назад». Старые `index.html` удалены, чтобы не осталось статических «входов» в обход стража (они дают 404).

Проверено HTTP-тестом: при `running` в `progress.json` главная и соседняя страница отдают `302`, своя — `200`; `start_*` соседа — `blocked`; после восстановления файлов всё снова `200` и флаги `false`.

**Ссылки в шапке повторяют эту же логику на клиенте.** Иначе ссылка выглядит живой, а по клику сервер молча отправляет обратно: «перехода нет», но кнопка нажимается. Правило ровно одно — **гасим всё, кроме своей страницы, пока идёт работа**:

| Ссылка | Закрыта, когда |
|---|---|
| «Главная» | работает **любой** модуль (её закрывает `enforceHome`) |
| соседний модуль | работает **он**; на «Стемах» — ещё и **своя** генерация (`ownBusy`) |
| своя страница | никогда (мы на ней) |

Механика блокировки **общая** — `StemUI.lockNav(link, locked, reason, onBlocked)` в `analysis/assets/js/core/ui.js`, а правила описывает страница через `StemUI.createNav({links: [{el, busy, reason}], onBlocked})`. Правило — это «когда блокировать и почему», механика (класс, `aria`, подсказка, отчёт о клике) — в ядре. Одна реализация на сколько угодно страниц вместо двух копий, которые разъезжаются.

**Поведение заблокированной ссылки:** атрибут `href` не удаляется, `pointer-events: none` не используется. Заблокированная ссылка получает класс `.is-locked` и `aria-disabled="true"`. При клике переход отменяется, а причина блокировки выводится в строку журнала. Серверную защиту обеспечивает `PageGuard` (302).

Точки обновления навигации централизованы: `updateProcessUI()` в analysis и `updateGenerateUI()` в stemgen. В модуле «Обработка» переход в «Стемы» блокируется до тех пор, пока в библиотеке нет хотя бы одного обработанного трека.

### 3.4 Общее UI-ядро — `analysis/assets/js/core/ui.js`

Общий модуль, подключается тегом `<script>` первым в `index.php` обоих модулей. Экспортирует `window.StemUI`:

| Метод / Функция | Контракт |
|---|---|
| `lockNav(link, locked, reason, onBlocked)` | Блокировка одной навигационной ссылки (`aria-disabled`, предотвращение перехода по клику). |
| `createNav(config)` → `updateNav()` | Контроллер навигации по массиву ссылок с функцией проверки занятости. |
| `stagePercent(index, total)` | Расчёт процента заполнения сегментированной шкалы по номеру шага (0..100%). |
| `createLogLine(el, {lifeMs, finalMs})` | Контроллер строки журнала под прогресс-баром: `append(type, text, {expire})`, `expire(ms)`, `hide()`, `final(entry, fallback)`. |

**Принципы вывода статусов и журнала:**
- **Единый источник сообщений:** ход работы демона отображается исключительно в строке журнала под прогресс-баром тулбара.
- **Живой процесс:** во время `status === 'running'` в журнал транслируется текущий этап и имя файла из `last_message`.
- **Финал прогона:** при переходе в `complete`, `error` или `stopped` итоговая сводка отображается однократно и автоматически гаснет через 3 секунды (`LOG_FINAL_MS = 3000`).
- **Ошибки и предупреждения:** кратковременные системные уведомления (отказ в запуске, блокировка) выводятся с автоскрытием через 4 секунды (`LOG_LIFE_MS = 4000`).

---

## 4. Контракты данных

### 4.1 `storage/progress.json` (и `stemgen_progress.json`)

```
{
  "run_id": "run_…",         // идентификатор прогона
  "status": "idle|running|complete|error|stopped",
  "total": 15,               // сколько файлов в прогоне
  "processed": 4,            // сколько обработано
  "current_file": "A - B.mp3",
  "current_stage": "bpm",     // этап текущего трека
  "current_stage_index": 2,   // индекс этапа в карте STAGES модуля — им заполняется шкала в таблице
  "current_stage_label": "определение темпа",
  "stop_requested": false,    // флаг остановки (ставит веб, читает демон)
  "last_ping": 1758000000,    // метка последней записи (Unix) — «живость» демона
  "last_message": { "time":"12:00:05", "type":"info|success|error|warning", "message":"…" } | null,
  "done_files":   { "A - B.mp3": { "id":"1a2b3c4d", "bpm":128, "key":"Am", "done_at":"…" } },
  "error_files":  { "C - D.mp3": { "error":"…" } },
  "folders": [{"name":"BPM128_KeyAm","files":["A - B.mp3"]}],
  "started_at": "…", "finished_at": null,
  "mode": "generate|cascade",          // режим демона; каскад пишет "cascade"
  "cascade_id": "1a2b3c4d",            // ID трека (только в mode=cascade)
  "cascade_stems": ["guitar","piano"]  // что делим (только в mode=cascade)
}
```

Намеренно **нет**: массива `log` (растущего), `live.progress` (долей) — по ним больше ничего не пишется. Журнал — одна строка `last_message`, она же источник live-строки на фронте.

Поля `mode`/`cascade_id`/`cascade_stems` появляются, когда работает каскад (см. §8.7): обычная генерация их не пишет, а фронт по `mode === 'cascade'` понимает, что прогресс относится к разделению Other, и не путает его с очередью стемов.

Правила `ProgressStore`:
- `reset($runId)` — «чистый» лист со `status=running` и `stop_requested=false`, пишет сразу. Новый прогон всегда начинается без флага стопа.
- `update($patch)` — `array_merge` поверх состояния, ключ `log` игнорируется; пишет сразу. Если патч трогает `stop_requested`, состояние сначала перечитывается с диска (`readFresh()`), иначе запись из старого кэша затрёт флаг.
- `requestStop()` — единственный способ поставить флаг из веба: сохраняет `stop_requested=true` в `$pendingStopFlag`, чтобы `write()` не потерял его на диске.
- `stopFlagFromDisk()` — текущее значение флага без кэша.
- `forget($file)` — убрать трек из `done_files`/`error_files` (откат незавершённого).
- `log($type,$msg)` — перезаписывает `last_message`.
- `markStage($stage, ?array $stages = null)` — пишет `current_stage`/`_label`/`_index` **один раз на смену этапа** (повтор того же этапа не пишет, иначе лента засорялась бы и перерисовывалась каждые 2 с). Второй аргумент — карта этапов модуля: по умолчанию `STAGES` (анализ, 7 шагов), «Стемы» передают `STEMGEN_STAGES` (5 шагов). Неизвестный этап игнорируется, чтобы ошибка в питоне не ломала прогон. Номер этапа = позиция в карте, поэтому она и есть порядок сегментов шкалы.
- `keepAlive($every=10)` — пишет, только если прошло ≥10 с с прошлой записи.
- `isStopRequested()` — читает файл напрямую (другой процесс!), кэш 250 мс.
- `read()` / `readFresh()` — `readFresh()` сбрасывает кэш: веб, ждущий признаков жизни запуска, обязан перечитывать файл.
- `write()` — `last_ping = time()`, затем `tmp` + `rename`; если флаг стопа брался с диска — записывается дисковое значение, а не кэш.

### 4.2 Ответ `get_progress`

```
{ …всё из progress.json…, "stemgen_running": false }   // analysis
{ …всё из progress.json…, "analysis_running": false }   // stemgen
```

Отдаётся весь state целиком, поэтому поля этапов (`current_stage`, `current_stage_index`, `current_stage_label`) фронту доступны без отдельных запросов — обе страницы рисуют по ним шкалу.

### 4.3 `storage/tracks.json`

Ключ — имя файла в нижнем регистре, значение — результат:

```
{ "a - b.mp3": { "status": "done", "bpm": 128, "key": "Am", "duration": 214.5, "updated_at": "…" } }
{ "broken.mp3": { "status": "error", "message": "…", "updated_at": "…" } }
```

`TracksIndex::buildRows()` соединяет файлы `inbox/` с кэшем и разбирает `Исполнитель — Название` (`parseTrackName`): убирается ведущий числовой префикс DJ-разметки (`01 - `).

---

## 5. Фронтенд

### 5.1 Общий принцип: опрос вместо потока

Ни в одном модуле больше нет SSE/EventSource. Оба фронтенда работают одинаково:

1. Кнопка → `start_*` → ответ `started | blocked | already_running | idle | error`.
2. `setInterval(pollProgress, 2000)` → `get_progress` → обновить индикатор, строку журнала, строки таблицы.
3. Терминальные статусы (`complete|error|stopped`) → снять таймер, показать итог через `logRunFinished()` (гаснет по `LOG_FINAL_MS`), обновить список.

Опрос `last_message` даёт живую строку журнала: `renderLogs(progress.last_message)` на каждом тике **внутри ветки `running`** — это и есть «текущий этап / текущий трек» без процентов. Вне `running` (терминальный статус, `idle`) `last_message` не рисуется сам по себе: в нём лежит либо сводка прошлого прогона, либо пусто. В терминальной ветке он используется один раз явно — как текст итоговой строки.

**Гейт запуска (`awaitingRun`).** Демон поднимается отдельным процессом, поэтому `progress.json` после старта ещё какое-то время отдаёт остаток **предыдущего** прогона. Раньше такой остаток принимался за финал только что запущенной работы: опрос останавливался, страница писала «Готово»/«Остановлено» (последнее ещё и красным `warning`), а кнопка снова становилась активной. Теперь оба модуля ждут первого `status='running'` с `LAUNCH_WAIT_MS = 25000`: до него любой не-`running` статус игнорируется (ни бейдж, ни журнал, ни строки не трогаются), а если демон так и не проснулся — состояние сбрасывается с сообщением об ошибке. При перезагрузке/входе на уже идущую генерацию гейт не мешает: там первый же ответ — `running`.

Клиентский детект мёртвого run — `isStaleRun(progress)` в `analysis.js`: если `last_ping` старше 120 с, фронт считает процесс упавшим, останавливает опрос и предлагает перезапустить (сервер при этом тоже освободит модуль по TTL 90 с). Это страховка UX, источник истины — сервер.

### 5.2 `analysis` (нативные ES-модули)

Порядок импортов: `main → {views, upload, analysis, sort, table, player}`; базовые `store/utils` — листья. Никакой сборки: браузер грузит файлы как есть. Перед модулями подключается **общее ядро `core/ui.js`** обычным `<script>` (см. 3.4) — из ES-модуля до него не добраться, а `utils.js` обращается к нему как к `window.StemUI`. Если файл не загрузился, `utils.js` падает с внятной ошибкой, а не молча рисует неправильные блокировки.

Центральное состояние (`store.js`):

```
state = {
  rows,                 // строки из get_inbox
  rowRefs: Map,         // name -> {tr, nameCell, bpmCell, …, playBtn, playBar, busyState}
  sort,                 // { key: 'num'|'track'|'bpm'|'key'|'duration', dir: 1|-1|0 }
  mode,                 // 'idle' | 'processing' | 'poll' | 'done'
  pollTimer, stopping,  // таймер опроса, нажата ли «Стоп»
  play: { audio, name } // экземпляр Audio + имя играющего трека
}
```

`POLL_INTERVAL = 2000`. `TERMINAL_STATES = {complete, error, stopped}`.

- **Старт** (`analysis.js`): `startPolling(true)` → `fetchJson('start_analysis')`; ответы `blocked|already_running|idle|error` показываются в логе и останавливают оптимистичный режим; `started` → продолжаем опрос.
- **Строки** (`table.js`): `renderTable` — полная перерисовка; `rowProcessing/rowDone/rowError` — live. Ветки аккуратно пересобирают `nameCell` и сохраняют `playBtn`/`playBar` из `rowRefs`, поэтому переживают ре-рендер.
- **Плеер** (`player.js`): один глобальный `Audio`. Кнопка-кружок с **inline-SVG** play/pause (не CSS-треугольник — тот раньше схлопывался в 0×0 при пересборке кнопок). Прогресс-бар виден сразу; время/заливка — после `loadedmetadata`. Перемотка — `setPointerCapture` по `.play-bar`, только для играющего трека. Тумблер «Подряд» (`#queue-check`): по `ended` берёт следующий обработанный трек из `state.rows` по кругу.
- **Сортировка** (`sort.js`): `num` — по имени, `bpm`/`duration` — числовые, `key` — строковая, `track` — Fisher–Yates. Во время `processing`/`poll` отключена.

Индикатор: `.progress-bar` с классом `.is-active` → `@keyframes progress-sweep` (полоса ездит). Класс вешается на `status === 'running'`, снимается в терминальных. **Процентов нет.** Загрузка файлов — отдельный `.progress-fill`, там остаётся браузерный процент по байтам (это честная величина, её не выкидывали).

### 5.3 `stemgen` (классические скрипты, `window.StemGen`)

Порядок подключения в `index.php`: **`core/ui.js` (общее ядро, см. 3.4) → `core/constants → core/dom → core/store → core/utils → services/api → services/notifier → services/download → engine/spectrum → ui/level-meter → engine/waveform → core/stem → core/track → engine/player → core/channel → ui/table → services/generation → app`**. Взаимные зависимости — через `G` (алиас `window.StemGen`), циклов нет.

Общее ядро грузится **первым и как обычный `<script>`**, а не модулем: модульные системы у страниц разные (analysis на ES-модулях, stemgen на `window.StemGen`), а код нужен обеим. Классический скрипт выполняется раньше отложенных модулей, поэтому `window.StemUI` готов к моменту их запуска.

- `services/api.js` — `fetchJson` + `G.api.base`.
- `services/generation.js` — `startGeneration` (ответы `blocked|already_running|idle|error|started`), `startPolling`, `pollProgress` (2 с, `renderLogs(p.last_message)`), `requestStop`, `updateGenerateUI` (`showProgress`).
- **Каскад «Other → Guitar/Piano» — отдельный поток поверх обычной генерации.** В `core/constants.js` — `STEM_CASCADE_ORDER = ['guitar','piano']` (порядок дочерних стемов под Other), `STEM_CASCADE_STAGES` (4 этапа: `load/demucs/save/done`) и расширенные `STEM_NAMES`/`STEM_FILE_SUFFIX` (`guitar`/`piano`). `ui/channel.js` рисует кнопку «Разделить (🎸/🎹)» **в левом нижнем углу панели канала Other** — абсолютное позиционирование, зеркало верхнего левого угла «папка + Other»; время остаётся справа сверху, поэтому строку времени кнопка не растит. По клику — `G.startCascade(id)`. `ui/table.js::buildChannelList()` достраивает Guitar/Piano **сразу под Other** — только если URL стема уже пришёл в `get_tracks`; `syncCascadeButtons()` держит видимость кнопки. `engine/track.js::addStems()` идёт по `STEM_ORDER.concat(STEM_CASCADE_ORDER)` и пишет `track.cascadeReady`. `services/generation.js::startCascade()` шлёт `split_instrument`, ведёт подпись «Идёт разделение» и чистит `state.cascadeId` в терминальной ветке — защита от «залипшей» кнопки после F5.
- **Контракт перезагрузки (общий для обеих страниц).** Демон живёт независимо от браузера, поэтому страница при загрузке **только читает** `get_progress` и, если `status === 'running'`, подписывается: `startPolling(false)`. Запуск (`start_generation`) живёт исключительно в `startGeneration()` и вызывается только кликом. `app.js` при этом подписывается на опрос, чтобы перезагрузка не выглядела как «ничего не запущено»: состояние показывают прогрессбар, кнопка «Стоп» и живая строка журнала.
- `startPolling()` при подключении **восстанавливает состояние страницы**: `state.generating = true`, показывает и разблокирует «Стоп», зовёт `updateGenerateUI()` (иначе после F5 кнопка «Сгенерировать» выглядела бы активной, а ссылки «Главная»/«Обработка» — открытыми, хотя демон работает). Параметр `launchGeneration` у `startPolling` не принимает ничего и ничего не запускает — он оставлен только для симметрии вызова с analysis.
- Опрос отдаёт и этап: `rowWorking(current_file)` переводит строку в режим «генерация…», затем `G.rowStage(current_file, current_stage_index, current_stage_label)` заполняет сегментированную шкалу. Порядок важен — `rowStage` игнорирует строку, которая ещё не в режиме `run`.
- `services/notifier.js` — `appendLog` (одноразовое, само гаснет)/`logRunFinished` (итог прогона из `last_message`)/`renderLogs` (строка этапа, держится)/`hideLogLine`, `showProgress` (тот же бегущий индикатор, что в analysis).
- `ui/table.js` — строки треков, play-иконка (inline-SVG) на трек, `showProgress` на строку во время генерации, `G.rowStage` — заполнение шкалы этапами (ширина считается общим `StemUI.stagePercent`, повтор того же этапа не перерисовывает полосу).
- `services/download.js` — `G.downloadStem(stem, trackName)`: забирает стем **тем же запросом, что и `Stem.load`** (статический относительный путь из `StemRegistry::stemUrl`) и отдаёт файл пользователю. Серверный экшен с `Content-Disposition` сознательно не заводили: он дал бы то же самое, но добавил бы в проект роутинг, файл-стример и проверку путей ради одной кнопки, а имя файла всё равно задаётся клиентом.
    - **Два пути, и разница не в коде, а в честности сообщения.** Основной — `showSaveFilePicker()` (File System Access API): тот же диалог «Сохранить как», но он **решается по факту записи** — `fulfilled` значит файл записан, `AbortError` значит пользователь нажал «Отмена». Имя уходит в `suggestedName`, поэтому в диалоге сразу видно `Artist - Song_vocal.mp3`. Строка `Сохранено: <имя>` пишется ровно в одной точке — после `writable.close()`. Раньше стоял `<a download>`, и журнал врал: у anchor нет обратной связи от диалога, `a.click()` возвращается сразу, а пользователь затем либо сохраняет, либо жмёт «Отмена» — надпись «Сохранено» появлялась в обоих случаях (то есть на каждой отмене).
    - Диалог открывается **до** `fetch` (сети): `showSaveFilePicker` требует живого пользовательского жеста (transient activation), который теряется после `await`. Побочный плюс — отменить можно, не дожидаясь загрузки.
    - **Запасной путь для Firefox/Safari** (API там нет) — старый `<a download>`. Обратной связи нет, поэтому журнал пишет не `Сохранено:`, а `Файл передан в загрузки:` — подтвердить запись без API нечем, и врать не нужно. `Отмена` (AbortError) в обоих путях молчит: пользователь сам сказал «не надо».
    - Blob в anchor-пути отпускается через `setTimeout(revoke, 60000)`: стем на 5 минут — это десятки мегабайт в памяти, но revoke сразу после `click()` иногда обрывает запись.
- `ui/table.js` + `table.css` — шкала этапов: `.cell-progress.is-staged`, число сегментов задаётся CSS-переменной `--stages` на самой полоске (analysis — 7, stemgen — 5). Разделители — `repeating-linear-gradient`, лишних DOM-узлов нет.
- `engine/waveform.js` — спектрограмма канала; `specDrawn`-флаг **сбрасывается на resize canvas**, иначе после ресайза остаётся пустая полоса (бывший баг). Курсор playback рисуется поверх огибающей, поэтому после `Стоп` чистую волну обязательно надо **перерисовать с `clearRect`**: просто «не рисовать бегунок» оставляет его края на холсте. За это отвечает `specHasCursor` — по нему видно, что на холсте вообще есть курсор.
- `ui/level-meter.js` — вертикальная громкость и мут. Управление: drag/click мышью, колесо мыши с шагом 5%, чекбокс включения канала.
    - Заливка `.eq-fill` масштабируется по вертикали через `scaleY`: `transform: translateX(-50%) scaleY(v * 0.95)` с `transform-origin: bottom center`. Коэффициент `0.95` оставляет аккуратный отступ от верхней границы рамки на 100% громкости, визуально согласуясь с отступами на 95%. Координаты ввода в `setFromEvent` откалиброваны под этот предел (`(y / rect.height) / 0.95`).
    - Громкость и мут связаны: канал активен при `volume > 0`. `setVolume(0)` глушит канал, `setVolume(>0)` включает обратно. `setEnabled(false)` сохраняет уровень в `lastVolume` для последующего восстановления.
- `ui/channel.js` — управление каналом стема, чекбокс активности, кнопка скачивания (`.chan-save`) и кнопка каскадного разделения Other (`G.startCascade`).
- **Перемотка трека (`Player.seekTo`)** — централизованная точка входа для всех каналов. Клик или жест по любому каналу карточки рассчитывает нормализованную позицию `0..1` от общей длительности трека.
- `ui/spectrum.js` — логарифмический спектроанализатор (40 Гц – 16 кГц), отрисовывается на canvas под заголовком играющего трека (`.meta-name`) на 60 fps с учётом `devicePixelRatio`.

Кэш браузера: при изменении CSS/JS в кодовой базе версия `?v=` поднимается в `index.php` для сброса кэша клиентов.

---

## 5.4 Адаптивная вёрстка и компоненты

Интерфейс оптимизирован для экранов от 320 px до 1920 px без горизонтальной прокрутки:

- **Перенос строк:** длинные имена файлов без пробелов переносятся через `overflow-wrap: anywhere` и `word-break: break-word`, исключая распирание таблиц.
- **Модуль «Стемы»:** сетка каналов `.stem-list` перестраивается с 4 колонок (десктоп) на 2 колонки (≤ 1100 px) и 1 колонку (≤ 620 px).
- **Модуль «Обработка»:** на экранах ≤ 760 px строки таблицы трансформируются в карточки (`display: block` у `tr`), а ячейки отображают названия колонок через псевдоэлементы `::before` из атрибутов `data-label`.
- **Тулбар и журнал:** блок индикатора и журнала (`.toolbar-right`) прижат к правому краю через `margin-left: auto`. На экранах ≤ 700 px тулбар переходит в вертикальную раскладку.
- **Стерео-эквалайзер (`#stereo-eq`):**
  - Размещён поверх тулбара с `position: absolute; inset: 0` и `min-height: 84px`. На экранах ≤ 700 px переходит в `position: relative` в общем потоке.
  - В состоянии покоя (`.is-idle`) воспроизводится плавная процедурная анимация огибающей на частоте 20 fps без нагрузки на аудио-контекст. При системном `prefers-reduced-motion` анимация замирает в статичном положении.
  - В активном режиме воспроизведения (`.is-active`) отображает спектр каналов (левый канал влево, правый вправо).
  - При видимой кнопке запуска анализа/генерации эквалайзер автоматически затухает (`opacity: 0.1`), не отвлекая от элементов управления.

---

## 6. Python-анализатор (`analysis/scripts/analyzer.py`)

### Запуск

```
python analyzer.py <абсолютный путь к треку> [файл-прогресса.json]
```

- Не получил файл → `{"status":"error","message":…}` в stdout, exit 1.
- Только последняя непустая строка stdout парсится как JSON (предупреждения/numpy-мусор не мешают).
- `sys.stdout.reconfigure(encoding="utf-8")` — иначе на Windows в pipe уйдёт ANSI-кодовая страница и кириллица разобьёт JSON.

### Стадии

| `reporter.target` | Фаза |
|---|---|
| 0.04 | инициализация |
| 0.55 | загрузка аудио (первые 240 сек — `BPM_LOOKAHEAD_S`, `librosa.load(duration=…, sr=22050, mono)`) |
| 0.80 | BPM (`librosa.beat.beat_track`, `hop_length=256`) |
| 0.93 | тональность (`chroma_cqt` × профили Крамханшла–Шмюклера, 12×2 корреляций) |
| 0.97 | метаданные (`mutagen`, `easy=True`) |
| 1.0 | готово |

`ProgressReporter` сглаживает `value → target` (коэффициент 0.35), пишет атомарно (tmp + `os.replace`).

### Ошибки

- Пустой сигнал в первых 30 с → `ValueError` → `{"status":"error"}`.
- Метаданные не критичны: `read_metadata` глотает исключения, поля остаются `null`.
- Ошибка инициализации numpy/librosa → сообщение об отсутствующих зависимостях, exit 1.

---

## 7. PHP-бэкенд по классам

### `core/PythonRunner.php`

`run($script, array $cliArgs = [], ?callable $stopCheck = null, string $python = '', ?callable $onStage = null): array` → `{stdout, stderr, exit_code, terminated}`.
Порядок аргументов именно такой: `stopCheck` третьим, путь к интерпретатору четвёртым, колбэк этапа пятым (в `StemService` он передаётся как `$onStage`).

1. Собирает `cmd = [python, script, ...args]`, `cwd = корень проекта`.
2. `proc_open` без `env` (см. раздел 1, п. 3). **`stderr` уходит во временный файл (`tempnam`)**, а не в pipe: неблокирующий `stderr`-pipe на Windows всё равно блокирует, пока дочерний процесс не закроет канал, и `stream_select` по нему «залипает». `stream_set_blocking($pipe, false)` под PHP 8.2 на Windows не помогает — неблокирующий режим там фактически не работает.
3. Только `stdout` в non-blocking и читается через `stream_select` с таймаутом — так цикл остаётся отзывчивым к `stopCheck` между «кусками» вывода. По одной строке за итерацию, чтобы длинный вывод Python не съедал память.
4. Построчный разбор stdout: строки вида `{"stage": ...}` передаются в колбэк `$onStage`; финальный статус определяется по последней строке, содержащей ключ `"status"`. В цикле выполняется опрос `stopCheck` (`usleep(20_000)`) и проверка `proc_get_status`.
5. Остановка → `terminate()` (`taskkill /PID /T /F` на Windows) → `stopped = true`.
6. После выхода: дочитывается остаток stdout, `stderr` читается из временного файла, файл удаляется, `proc_close()`.
7. Если потомок держит канал stdout, после `terminate()` даётся до 30 с на вычитывание, затем канал закрывается принудительно — демон не должен зависнуть на «мёртвом» процессе.

### `core/SpawnCli.php`

`spawn($script, $stdoutLog)` и `logTail($log, 8)`.

- Интерпретатор — `STEMPLAYER_PHP` / `PHP_BINDIR` / `PHP_BINARY`, но под Apache кандидат-`httpd.exe` отбрасывается проверкой `/php\.exe$/i`.
- Windows: `proc_open` с `bypass_shell => true`, `cwd = корень`, stdout/stderr → в файлы `$log` и `$log.err`. Конструкция `start /B` под Apache не стартует — поэтому прямой `proc_open`. **`proc_close()` не зовём**: он ждёт завершения демона, а тот живёт дольше запроса; хендл освободится вместе со скриптом, потомок продолжит работу.
- `logTail` всегда возвращает валидный UTF-8 (вывод внешних программ бывает windows-1251, на котором `json_encode` падает) — этот хвост показывается в UI, если демон не подал признаков жизни.

### `analysis/analysisApi.php`

- `handleStartAnalysis`: проверки порядка — уже идёт (`already_running`) → сосед жив (`blocked`) → inbox пуст (`idle`) → `flock` на `storage/analysis_start.lock` → `SpawnCli::spawn(cli/analyze_cli.php)` → **ожидание признаков жизни**: до 4 с (20 × 200 мс) опросом `readFresh()` ждём новый `run_id`/рост `last_ping`; если тишина — отдаём `error` с `logTail` (причина видна прямо в UI).
- `handleGetProgress` / `handleGetInbox` добавляют `stemgen_running` (раздел 3).
- `handleStopAnalysis`: не идёт → `idle`; иначе `requestStop()` (см. раздел 1, п. 8 — обычный `update()` здесь флаг затирал кэшем).
- `handleDeleteTrack` (POST, form-поле `name` — **не query-строка**, иначе кириллица ломалась на `+`/`%20`): `name` обязателен, чужой action не перехватывается; живая очередь анализа или генерации → `blocked` (проверяется и живой демон, и `progress.json` со свежим `last_ping` — «хвост» мёртвого прогона блокировать не должен); дальше весь ввод-вывод только внутри `TrackCleaner`.
- `Http::jsonResponse()` — JSON и `exit` (тип `never`).

### `analysis/classes/TrackCleaner.php`

Удаление трека = удалить исходник из `music/inbox/`, копию из `music/sorted/`, каталог `{id}/` со стемами, запись из `storage/tracks.json` и хвост `progress.json` (`forgetEverywhere()`). Правила: имя не может быть пустым/`.`/`..`/с разделителем пути; каждый канонический путь обязан лежать внутри своей базы после `realpath()` — это же отсекает symlink-ходы; в `music/sorted/` удаляются только каталоги `BPM*_Key*` верхнего уровня, не принадлежащие треку ничего не трогают; `meta.json` читается до удаления, а `{id}/` сверяется с ним же. Возвращается `deleted` (что именно) — его и показывает лента на 4 секунды.

### `analysis/classes/AnalysisRunner.php`

`run(ProgressStore $store, array $files): array` — тело демона:

- `reset($runId)` → `update(total, stop_requested:false)`.
- Цикл по файлам: `log()` текущего, `markStage('start')`, `PythonRunner` c `stopCheck` (кооперативный стоп), четыре ветки ошибок (Throwable, status≠success, пустые BPM/Key, неудачный `moveToSorted`) — **не прерывая цикл**.
- Успех: `moveToSorted()` + `tracks.json` + `markStage('done')` + `markDone()` + `log()`.
- Стоп замечен → `rollbackTrack($name)`: копия из `music/sorted/`, созданные `{id}/` и `{id}/meta.json`, запись `tracks.json` (`TracksIndex::forget()`), отметки в `done_files`/`error_files` (`ProgressStore::forget()`). Исходник в `music/inbox/` остаётся, каталоги стемов не трогаются.
- Финал: `folders`, `status=complete|stopped|error`, `finished_at`. При остановке `processed` = числу действительно завершённых треков, а не `count($files)`.

### `analysis/classes/TracksIndex.php`, `FileSorter.php`, `UploadService.php`

- `TracksIndex` — кэш; `buildRows`; `parseTrackName`; `prettify`.
- `FileSorter::sanitizeFolderName("128","C#m")` → `BPM128_KeyCsM` (`#→s`, `b→f`, `minor→m`, суффикс в верхний регистр, `- / пробелы → _`). `moveToSorted` копирует в `music/sorted/BPM…_Key…/`.
- `UploadService::handle(?array $files, $inboxDir)` — пустое поле → подсказка про `post_max_size`; `UPLOAD_ERR_*` → человеческий текст; фильтр по `STEMPLAYER_AUDIO_EXT`; `sanitizeUploadName` + `uniqueInboxPath` (`_1`, `_2`…); ответ `{status, uploaded, rejected:[{name,reason}]}`.

### `stemgen/stemgenApi.php`

Симметрично: `handleStartGeneration` (та же тройка проверок + `flock` на `storage/stemgen_start.lock` + ожидание признаков жизни), `handleGetProgress`/`handleGetTracks` добавляют `analysis_running`, `handleStopGeneration` ставит `stop_requested`.

### `stemgen/classes/StemRunner.php`

`run(ProgressStore $store, array $tracks): array` — последовательная очередь Demucs (см. раздел 8). Внутри: `store->keepAlive()` в цикле ожидания, кооперативный стоп между треками и во время генерации.

При остановке вызывается `rollbackRunDirs($runDirs)` — удаляются **все** каталоги стемов, задетые текущим прогоном (не только тот, на котором оборвалось). Исходники в `music/sorted/` и ранее готовые треки (созданные другим прогоном) не трогаются. Метод вынесен отдельно от `run()`, чтобы его можно было покрыть тестом без реального Demucs.

### Откат незавершённого трека

Остановка на середине не должна оставлять «полуготовость»: папку с исходником без метаданных, каталог `{id}/` с одним стемом, запись в `tracks.json` со статусом не `done`. Правило одно: **откатывается только то, что создал текущий прогон**.

`AnalysisRunner` при замеченном стопе зовёт `rollbackTrack($name)`:

| Артефакт | Действие | Инструмент |
|---|---|---|
| копия в `music/sorted/BPM…_Key…/` | удаляется | `FileSorter::sortedPathFor()` |
| каталог `{id}/` + `{id}/meta.json` | удаляется, **только если создан этим прогоном** | — |
| запись в `storage/tracks.json` | убирается | `TracksIndex::forget()` |
| отметка в `done_files` / `error_files` | убирается | `ProgressStore::forget()` |
| исходник в `music/inbox/` | **остаётся** | — |
| ранее готовые треки и каталоги стемов | **остаются** | — |

`StemRunner` при стопе зовёт `rollbackRunDirs($runDirs)` — по списку каталогов, задетых прогоном. Исходники в `music/sorted/` не трогаются: они принадлежат модулю «Обработка».

Зачем это проверять тестом, а не «на глаз»: демон, веб-страница и сам тест работают с одним `progress.json`, поэтому тесты не подменяют и не откатывают этот файл — иначе они затирают состояние прогона и разбор становится невозможным.

---

## 8. Модуль «Стемы» (`stemgen/`)

### 8.1 Идентификация треков

`StemRegistry::idFor($fileName, $bpm, $key)` = `substr(md5(имя файла . BPM . Key), 0, 8)`. Ключи папок декодируются обратно: `AsM→A#m`, `AM→Am`, `FsM→F#m`, `C→C`.

Источник — только `music/sorted/`. Каталог готовых стемов: `music/sorted/BPM…_Key…/{ID}/{ID}_{stem}.mp3`. Таблица (`listTracks`) собирает строки из двух источников: mp3-исходники в папках `BPM…_Key…` и каталоги `{8 hex}/` (для уже разделённых треков имя восстанавливается из `{id}/meta.json`), дубликаты схлопываются по `id`.

### 8.2 Очередь

`StemRunner::run` по трекам последовательно (одна GPU-сессия за раз):

1. Пропуск, если `done`; проверка `stop_requested` между треками; `keepAlive()` в ожидании. Каждый затронутый каталог `{id}/` запоминается в `$runDirs` — по нему потом делается откат.
2. `StemService::generateStems(...)`:
   - безопасность: `resolveInSorted()` для входа и выхода (только реальные пути внутри `music/sorted/`), `$id` строго `^[0-9a-f]{8}$`;
   - `outputDir` = **родитель** каталога `{ID}/` (скрипт сам создаёт `{ID}/`);
   - вызов splitter'а через `PythonRunner` с `STEMGEN_PYTHON` (venv, не системный python);
   - верификация: все `STEMGEN_STEMS` как `{ID}/{ID}_{stem}.mp3` + `meta.json`, и только потом `STEMGEN_DELETE_SOURCE` удаляет исходник.
3. Состояние — в `storage/stemgen_progress.json` (отдельный инстанс `ProgressStore` с `STEMGEN_PROGRESS_FILE`).
4. Остановка → `rollbackRunDirs()` по списку `$runDirs`, `status=stopped`.

### 8.3 `stem_splitter.py`

```
python stem_splitter.py <input> <output_dir> <id> <bpm> <key> <model> <bitrate> <two_stems:0|1> [progress_file]
```

- `output_dir` = каталог `BPM…_Key…`; результат — `{id}/{id}_{stem}.mp3` + `meta.json {original_name, bpm, key}`.
- Перед Demucs — `ensure_ffmpeg()`: если `ffmpeg` недоступен из PATH (типично для Apache под системной учёткой), ищет `ffmpeg.exe` в WinGet/Chocolatey/`C:\ffmpeg` и подмешивает каталог в PATH процесса. Без этого demucs не декодирует mp3 и не пишет mp3-стемы.
- Команда: `python -m demucs -n <model> --mp3 --mp3-bitrate <bitrate> -o <output_dir> <input>`; `two_stems=1` добавляет `--two-stems vocals`.
- Поиск выходов `find_stems()`: рекурсивно по `output_dir` ищет `vocals/drums/bass/other` (или `no_vocals.mp3`); файлы переносятся в `{id}/`, мусор `output_dir/<model>/` удаляется.
- В stdout — **построчно JSON**, тем же протоколом, что `analyzer.py`:
  - `{"stage": "load|demucs|collect|save|done"}` — ход работы, им заполняется сегментированная шкала в карточке трека;
  - `{"status": "done", "id": …, "stems": […]}` либо `{"status": "error", "message": …}` — итог.
  PHP различает их по наличию ключа `stage`, `StemService` берёт последнюю строку **со `status`**.

Этапы разделения трека разбиты на 5 дискретных сегментов (`ProgressStore::STEMGEN_STAGES`): `load` → `demucs` → `collect` → `save` → `done`. Шкала карточки в UI отображает их пропорционально номеру текущего этапа.

### 8.4 Окружение (проверено)

- `venv_demucs/`: torch 2.5.1+cu121, torchvision 0.20.1+cu121 — **CUDA-сборка**, `torch.cuda.is_available()==True` на GeForce GTX 1060 6GB.
- Установка затяжная (wheel 2.4 ГБ) — ставить в фоне, не в long-running вызове; следить за местом на диске (`pip` распаковывает wheel в `%TEMP%`).
- `demucs 4.1.0` + `ffmpeg` обязательны вместе (см. 8.3).

### 8.5 Подводные камни контракта путей

- `StemRunner` передаёт в сервис `outputDir = dirname(stemDir)` — **родителя**: скрипт прибавляет `{id}/`. Если передать сам `{id}`, будет вложенность `{id}/{id}/` и верификация не найдёт `meta.json`.
- `StemService` валидирует сам `$id`, а не `basename(outputDir)`, т.к. базовое имя `outputDir` — папка `BPM…_Key…`.

### 8.6 Кеш волновых форм (`stemgen.wave.v1`)

Раньше каждая загрузка страницы заново скачивала и полностью декодировала каждый MP3-стем ради картинки огибающей (`fetch` + `OfflineAudioContext.decodeAudioData`). На библиотеке это десятки мегабайт и заметная пауза при каждом входе.

Теперь волна хранится не как canvas, а как **802 пика** (800 колонок `Uint8` + небольшой HTML-кэш) в `localStorage` под ключом `stemgen.wave.v1` — порядок 1.1 КБ на стем вместо полного декодирования:

- ключ записи = `URL + '|' + mtime` файла; mtime приходит из `get_tracks` в новом поле `stem_revs` (`StemRegistry::stemRevs()`, только `stat()`, содержимое не читается);
- после перегенерации трека mtime меняется → ключ не совпадает → волна пересчитывается сама, ручная очистка не нужна;
- запись добавляется, лишнее усекается с начала до `MAX_ENTRIES = 600` (старшие записи); при недоступном `localStorage` (приватный режим/квота) модуль работает без кеша;
- `Stem` (в `track.js`) хранит `rev` и переиспользует декодированный буфер только при совпадении `url` **и** `rev` — несовпадение ревизии пересоздаёт стем даже при том же URL (ID трека зависит только от имени/BPM/тональности, поэтому URL после перегенерации не меняется).

Проверено на 6 треках: первый вход — 24 скачивания + декодирование; повторный (F5) — **0** сетевых запросов, волны рисуются сразу.

### 8.7 Каскад: Other → Guitar/Piano (`split_instrument.py` + `cascade_cli.php`)

Второй проход по стему `other` (в UI — **Other**): модель `htdemucs_6s` — единственная в Demucs, отдающая гитару и пиано отдельными стемами. Результат — `{ID}/{ID}_guitar.mp3` и `{ID}/{ID}_piano.mp3` рядом с базовыми стемами; в `{id}/meta.json` пишутся `cascade_done`, `cascade_stems`, `cascade_updated_at`.

**Отдельный демон, а не синхронный вызов в API.** Тяжёлая работа идёт минутами, поэтому каскад, как и генерация, поднимается фоновым CLI-процессом и возвращает `{"status":"started"}` сразу (вкладку можно закрыть). Ключевое отличие: демон запускается **без аргументов** (`SpawnCli::spawn` их не принимает), поэтому «что делить» он узнаёт из **файла-дескриптора** `storage/cascade_request.json` (`{"id":"…","stem":"other"}`) — его пишет API, читает и **удаляет** демон. Так соблюдена модульная конвенция «обмен через диск» и не тронуто ядро.

```
python split_instrument.py <input_other.mp3> <output_dir> <id> <model> <bitrate> <shifts> <overlap>
```

- `input_other.mp3` — `{ID}/{ID}_other.mp3`; `output_dir` — каталог `BPM…_Key…` (скрипт сам кладёт в `{ID}/`).
- Команда: `python -m demucs -n <model> --mp3 --mp3-bitrate <bitrate> --shifts <shifts> --overlap <overlap> -o <temp> <input>`.
- Протокол stdout — тот же построчный JSON, что у `stem_splitter.py`: `{"stage": "load|demucs|save|done"}` (шкала в карточке) и финальная строка `{"status": "done"|"error"}`. Этапы каскада — `ProgressStore::STEMGEN_CASCADE_STAGES` (4 шага, отдельная карта от 5 шагов генерации).
- Прогресс пишется в **общий** `stemgen_progress.json`, но с `mode:"cascade"` (плюс `cascade_id`/`cascade_stems`) — фронт по этому полю понимает, что идёт разделение, и не путает его с очередью.

**П.1 качества (флаги Demucs).** `htdemucs_6s` делит гитару/пиано слабо, поэтому второй проход идёт с TTA-усреднением и перекрытием сегментов: `--shifts 3` (усреднение по 3 сдвигам) и `--overlap 0.5`. Больше значение — чище, но кратно дольше (`shifts` множит время прогона). Значения берутся из `STEMGEN_CASCADE_SHIFTS`/`STEMGEN_CASCADE_OVERLAP` и пробрасываются из `StemService::splitInstrument()`.

**Блокировки и стоп — те же, что у генерации.** Старт-лок `storage/stemgen_start.lock`, проверки `RunState`, флаг `stop_requested` и кооперативный стоп через `PythonRunner` (`taskkill /T`). `StemService::splitInstrument($id, $stem, $stopCheck, $onStage)` валидирует `$id` (`^[0-9a-f]{8}$`) и путь, вызывает скрипт и верифицирует оба выходных файла.

Каскадное разделение выполняется асинхронно отдельным CLI-демоном (`cascade_cli.php`), исключая длительное удержание HTTP-соединения веб-сервера. Запрос формируется через файл-дескриптор `storage/cascade_request.json`, API сразу возвращает `{"status":"started"}`, а клиент отслеживает ход выполнения через периодический опрос `get_progress`.

---

## 9. Сборка и проверки

Сборка не требуется. Проверка работоспособности после правок кода:

```bash
# 1. Проверка синтаксиса PHP
php -l index.php
php -l config.php
Get-ChildItem -Recurse -Include *.php | ForEach-Object { php -l $_.FullName }

# 2. Проверка синтаксиса JS
Get-ChildItem -Recurse -Include *.js | ForEach-Object { node --check $_.FullName }

# 3. Компиляция Python-скриптов
python -m py_compile analysis/scripts/analyzer.py
python -m py_compile stemgen/scripts/stem_splitter.py
python -m py_compile stemgen/scripts/split_instrument.py

# 4. Smoke-тестирование API (при работающем Apache)
curl -s "http://127.0.0.1/StemPlayer/analysis/analysisApi.php?action=get_progress"
curl -s "http://127.0.0.1/StemPlayer/analysis/analysisApi.php?action=get_inbox"
curl -s "http://127.0.0.1/StemPlayer/stemgen/stemgenApi.php?action=get_progress"
curl -s "http://127.0.0.1/StemPlayer/stemgen/stemgenApi.php?action=get_tracks"
```

### Сквозные функциональные проверки

1. **Анализ треков:** загрузка файла в дропзону → старт обработки → проверка формирования каталога `music/sorted/BPM*_Key*/` → воспроизведение из таблицы.
2. **Разделение на стемы:** открытие модуля «Стемы» → старт генерации → верификация появления стемов (`vocals`, `drums`, `bass`, `other`) в `{id}/` и обновления `meta.json`.
3. **Каскад:** клик по кнопке «Разделить (🎸/🎹)» на канале Other → проверка создания `_guitar.mp3` и `_piano.mp3` и появления каналов под Other.
4. **Остановка и откат:** нажатие кнопки «Стоп» во время работы → завершение фонового процесса (`taskkill /T`) → удаление незавершённых директорий и записей, сохранение ранее готовых треков.
5. **Взаимная блокировка:** запуск анализа или стемов → попытка перехода на соседнюю страницу (должен происходить HTTP 302 редирект на активный модуль) → проверка отключения кнопок навигации.

---

## 10. Справочник конфигурации (`config.php`)

| Константа | По умолчанию | Назначение |
|---|---|---|
| `STEMPLAYER_PYTHON` | `python` (или env) | Python для модуля «Обработка» |
| `STEMPLAYER_PHP` | `C:/xampp/php/php.exe` (или env) | PHP для запуска CLI-демонов (под Apache `PHP_BINARY` = `httpd.exe`) |
| `STEMPLAYER_MAX_EXEC_TIME` | `0` | Лимит времени long-running операций, сек (0 = без лимита) |
| `STEMPLAYER_AUDIO_EXT` | 9 расширений | Какие файлы считать аудио |
| `ANALYSIS_PROGRESS_FILE` | `storage/progress.json` | Файл состояния демона «Обработка» |
| `STEMPLAYER_ANALYSIS_PAGE` | `analysis/index.php` | URL страницы «Обработка» (для блокировок и редиректов) |
| `STEMPLAYER_STEMGEN_PAGE` | `stemgen/index.php` | URL страницы «Стемы» |
| `STEMGEN_PYTHON` | `venv_demucs/Scripts/python.exe` (или env) | Python для Demucs (torch+CUDA+demucs) |
| `STEMGEN_DEMUCS_MODEL` | `htdemucs_ft` | Модель Demucs (4 стема: `vocals`, `drums`, `bass`, `other`) |
| `STEMGEN_STEMS` | 4 стема | Имена стемов в порядке выхода |
| `STEMGEN_MP3_BITRATE` | `320` | Битрейт mp3-стемов, kbps |
| `STEMGEN_DELETE_SOURCE` | `true` | Удалять исходник из `music/sorted/` после успешного разделения |
| `STEMGEN_PROGRESS_FILE` | `storage/stemgen_progress.json` | Файл состояния демона «Стемы» |
| `STEMGEN_CASCADE_MODEL` | `htdemucs_6s` | Модель каскада (6 стемов: 4 базовых + `guitar`, `piano`) |
| `STEMGEN_CASCADE_SOURCE_STEM` | `other` | Исходный стем каскада (в UI — Other) |
| `STEMGEN_CASCADE_STEMS` | `['guitar','piano']` | Что достаём из Other |
| `STEMGEN_CASCADE_SHIFTS` | `3` | TTA-усреднение Demucs каскада (`--shifts`): больше — чище и дольше |
| `STEMGEN_CASCADE_OVERLAP` | `0.5` | Перекрытие сегментов каскада (`--overlap`) |
| `STEMGEN_CASCADE_REQUEST_FILE` | `storage/cascade_request.json` | Файл-дескриптор запроса каскада |

Ключи `STEMPLAYER_*` / `STEMGEN_*` переопределяются одноимёнными переменными окружения. Лимиты загрузки — в `.htaccess` (`upload_max_filesize`, `post_max_size`, `max_file_uploads`, `max_execution_time`).

## 11. Справочник API (actions)

Все запросы — GET-параметром `action=…` (кроме загрузки — POST multipart).

### Модуль «Обработка» — `analysis/analysisApi.php`

| action | Метод | Назначение |
|---|---|---|
| `start_analysis` | GET | Поднять CLI-демон обработки. Ответы: `started`, `already_running`, `blocked`, `idle`, `error` |
| `get_progress` | GET | Состояние `storage/progress.json` + флаг `stemgen_running` |
| `get_folders` | GET | Дерево `music/sorted/` |
| `get_inbox` | GET | Строки таблицы (файлы inbox + кэш результатов) + `stemgen_running` |
| `upload` | POST | multipart, поле `files[]` — загрузка треков |
| `stop_analysis` | GET | Запросить остановку текущего анализа |
| `delete_track` | POST | form-поле `name` — удалить трек (Inbox + `music/sorted/` + стемы + `storage/`). Отказы: `blocked`, `error` |

### Модуль «Стемы» — `stemgen/stemgenApi.php`

| action | Метод | Назначение |
|---|---|---|
| `get_tracks` | GET | Все треки `music/sorted/` со статусом стемов (`id`, `done`, URL стемов, `cascade_ready`) + `analysis_running` |
| `start_generation` | GET | Поднять CLI-демон генерации. Ответы: `started`, `already_running`, `blocked`, `idle`, `error` |
| `split_instrument` | GET | Каскад: разделить Other на Guitar/Piano. Параметры `id`, `stem` (по умолчанию `other`). Ответы: `started`, `already_done`, `blocked`, `error` |
| `get_progress` | GET | Состояние `storage/stemgen_progress.json` + `analysis_running` |
| `stop_generation` | GET | Запросить остановку очереди |

Идентификатор трека: `ID = substr(md5(<имя файла> + BPM + Key), 0, 8)` (8 hex-цифр). Выход — `music/sorted/BPM…_Key…/{ID}/{ID}_{stem}.mp3` + `meta.json`. Любой путь обязан оставаться внутри `music/sorted/`.

Пример загрузки:

```
curl -F "files[]=@track.mp3" "http://127.0.0.1/StemPlayer/analysis/analysisApi.php?action=upload"
```

## 12. Куда смотреть при правках

| Хочется… | Идти в… |
|---|---|
| Изменить поры сердцебиения / TTL блокировки | `core/RunState.php` (`isFresh`, 90 с / 30 мин) |
| Поведение страниц при занятом соседе | `core/PageGuard.php` + вызовы в трёх `index.php` |
| Ответы `start_*` (blocked/started/error) | `analysis/analysisApi.php::handleStartAnalysis`, `stemgen/stemgenApi.php::handleStartGeneration` |
| Фоновый запуск демона, путь к PHP | `core/SpawnCli.php` + `STEMPLAYER_PHP` в `config.php` |
| Состав progress.json | `core/ProgressStore.php` (`blank()`, `write()`) |
| Этапы трека (start→load→bpm→key→meta→save→done) и заполнение шкалы | `analysis/scripts/analyzer.py` (`ProgressReporter`) + `ProgressStore::STAGES` + `analysis/assets/js/table.js` (`markRow`) |
| Что происходит по кнопке «Стоп» | `ProgressStore::requestStop()` (веб) → `PythonRunner` (`stopCheck`) → `AnalysisRunner::rollbackTrack()` / `StemRunner::rollbackRunDirs()` |
| Сообщения live-журнала на фронте | `ProgressStore::log()` (демон) + `renderLogs()` (фронт) |
| Бегущий индикатор | `analysis/assets/css/components.css` (`.progress-bar.is-active`) + `showProgress()` на обоих фронтах |
| Play-иконка | `analysis/assets/js/player.js`, `stemgen/assets/js/{core/dom,ui/table}.js` + CSS `table.css` / `stemgen.css` |
| Физика EQ/waveform | `stemgen/assets/js/engine/waveform.js`, `stemgen/assets/css/stemgen.css` (`.chan-right`, `.chan-eq-pct`) |
| Фазы анализа (BPM/Key) | `analysis/scripts/analyzer.py` (`ProgressReporter`, `reporter.target`) |
| Порядок файлов, колонки таблицы | соответствующий `index.php` + `table.js` / `ui/table.js` + CSS |
| Кэш браузера после правки ассета | `?v=` в нужном `index.php` (общие — в обоих) |
| Логика очереди «Подряд» | `analysis/assets/js/player.js` (`playNextInQueue` + `ended`) |
| Окружение Demucs | `venv_demucs/` (`STEMGEN_PYTHON`) + ffmpeg; правки — `config.php` |
| Каскад Other → Guitar/Piano | `stemgen/scripts/split_instrument.py` + `stemgen/cli/cascade_cli.php` + `StemService::splitInstrument()` + кнопка в `stemgen/assets/js/ui/channel.js` |
| Новый модуль | сначала ядро: `Http`/`ProgressStore`/`RunState`/`PageGuard`/`SpawnCli`/`PythonRunner`; затем папка модуля + `{модуль}Api.php` + `index.php` со стражем |

Пользовательское описание и установка — в [README.md](README.md); справочники конфигурации и API — разделы 10–11 выше.
