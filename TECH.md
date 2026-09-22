# StemPlayer — техническая документация

Внутреннее устройство: архитектура «ядро + модули», потоки данных, контракты API, ключевые решения и замечания по поводу специфики Windows. Пока реализован один модуль — «Обработка» (`analysis/`).

---

## 1. Общая архитектура

Три уровня, разделённых по зонам ответственности:

```
┌─────────────────────┐   HTTP/SSE   ┌──────────────────────┐
│   Фронтенд          │ ───────────► │   API-слой модуля     │
│   analysis/assets/js│              │   analysis/           │
│   (ESM)             │              │   analysisApi.php     │
│   analysis/assets/  │ ◄─────────── │   analysis/classes/   │
│   css/*.css         │              └──────────┬───────────┘
└─────────────────────┘                         │ proc_open
                                                 ▼
                              ┌──────────────────────────────┐
                              │  core/PythonRunner.php        │
                              │  ──► analysis/scripts/analyzer.py
                              │      (librosa, numpy, mutagen) │
                              └──────────────────────────────┘
```

- **Фронтенд** — девять ES-модулей без сторонних зависимостей (ни jQuery, ни bundler'а в рантайме). Страница работает только по HTTP(S), не по `file://`.
- **API** — у каждого модуля свой front-контроллер `{модуль}Api.php` с роутером `match($action)`. Тяжёлая логика вынесена в классы каталога модуля; всё переиспользуемое — в `core/`.
- **Ядро** (`core/`) — `Http` (JSON/SSE), `ProgressStore` (состояние), `PythonRunner` (запуск python). Модули не знают друг о друге, ядро не знает о модулях.
- **Анализ** — внешний Python-процесс. PHP никогда не прикасается к аудио: вся DSP живёт в `analyzer.py`.

Принципиальные решения:

1. **Прогресс — через файл, а не через pipe.** На Windows неблокирующее чтение `stderr`-пайпа прозрачно блокируется, пока дочерний процесс не закрыл канал: события "замерзают" до конца анализа. Поэтому `analyzer.py` пишет живой прогресс в JSON-файл (атомарно через `os.replace`), а `PythonRunner` опрашивает его в цикле `proc_get_status`.
2. **Не передавать `$_SERVER` как окружение в `proc_open`.** На Windows PHP искажает окружение дочернего процесса — python перестаёт находиться. `env` не передаётся вовсе, окружение наследуется.
3. **Атомарная запись состояния.** `ProgressStore` пишет во временный файл и переименовывает: читатель никогда не увидит "обрезанный" JSON; flock-гандикап на чтение не нужен.
4. **SSE работает только на Apache.** `php -S` однопоточный — второй параллельный запрос (поллинг прогресса) встанет в очередь за стримом. В `.htaccess`/коде выключены gzip, `zlib.output_compression` и `X-Accel-Buffering`.
5. **Остановка — кооперативная.** Кнопка «Стоп» ставит флаг `stop_requested` в `progress.json`. Цикл анализа проверяет его между треками, `PythonRunner` — во время анализа (терминирует python и его детей через `taskkill /T`). Текущий трек не спасается.

---

## 2. Дерево проекта и назначение файлов

```
index.php              — посадочная страница со списком модулей (http://host/StemPlayer/)
config.php             — STEMPLAYER_PYTHON / STEMPLAYER_MAX_EXEC_TIME / STEMPLAYER_AUDIO_EXT
.htaccess              — upload_max_filesize 300M, post_max_size 310M, max_file_uploads 60, max_execution_time 0

core/                  — ядро, общее для всех модулей
  Http.php             — JSON-ответы и SSE-события
  ProgressStore.php    — состояние анализа в storage/progress.json (атомарная запись)
  PythonRunner.php     — запуск python через proc_open, опрос JSON-прогресса, кооперативный стоп

analysis/              — модуль «Обработка»
  index.html           — вся разметка страницы, подключение CSS и <script type="module">
  analysisApi.php      — роутер действий + функции-обработчики
  assets/css/
    base.css           — :root переменные, reset, body, .app, @keyframes shimmer/blink
    components.css     — header, status-badge, .btn-*, progress-track/fill, dropzone, журнал,
                         тумблер «Подряд» (.queue-toggle, Apple-стиль)
    table.css          — тулбар, banner, таблица, колонки, плеер, cell-progress, chips, @media
    Порядок подключения ВАЖЕН: base → components → table (@media в конце table.css
    перекрывает правила из первых двух файлов).
  assets/js/           (см. раздел 4)
    main.js            — инициализация
    store.js           — синглтон-состояние, els, POLL_INTERVAL, TERMINAL_STATES, api.base
    utils.js           — fetchJson, fmtDuration, setBadge, журнал, buildNameNode
    player.js          — Audio-плеер в строках таблицы + очередь «Подряд»
    table.js           — renderTable и обновление строк в реальном времени
    sort.js            — сортировка/перемешивание по заголовкам
    views.js           — переключение вью (upload/tracks), баннер по завершении
    upload.js          — загрузка multipart, refreshInbox
    analysis.js        — SSE-клиент + фолбэк-поллинг + остановка
    sorter.min.js      — сборка всех модулей одним файлом (node tools/build.js)
  classes/
    AnalysisService.php— анализ одного файла: вызывает core/PythonRunner, разбирает stdout
    AnalysisRunner.php — общий цикл анализа всех файлов (SSE-стрим и фолбэк)
    AnalysisInterface.php— контракт runAnalysis
    TracksIndex.php    — кэш результатов анализа в storage/tracks.json + сборка строк таблицы
    FileSorter.php     — перекладывание в music/sorted/, безопасные имена папок
    SortingInterface.php— контракт сортировщика
    UploadService.php  — приём multipart-загрузки, санитизация имён, уникализация
  scripts/analyzer.py  — Python-анализатор (см. раздел 5)
  music/
    inbox/             — загруженные треки (источник анализа)
    sorted/            — результат: BPM128_KeyAm/ и т.п.

tools/build.js         — сборка analysis/assets/js/sorter.min.js (Node, модулей 9)

storage/               — создаётся при первом запуске
  progress.json        — текущий статус/прогресс анализа
  tracks.json          — кэш результатов по именам файлов
```

Все пути в классах — `__DIR__`-относительные: `core/` живёт на уровень выше `analysis/classes/`, поэтому там `../../`. `storage/` и `music/` — общие для всего проекта.

---

## 3. Контракты данных

### 3.1 `storage/progress.json`

```
{
  "run_id": "run_66f1…",        // идентификатор прогона
  "status": "idle|running|complete|error|stopped",
  "total": 15,                  // сколько файлов в прогоне
  "processed": 4,               // сколько обработано (или остановка)
  "current_file": "A - B.mp3",  // текущий файл (пуст после завершения)
  "stop_requested": false,      // флаг остановки
  "live": {"name": "A - B.mp3", "progress": 0.63, "phase": "определение BPM"} | null,
  "log": [{"time": "12:00:05", "type": "info|success|error|warning", "message": "…"}],
  "folders": [{"name": "BPM128_KeyAm", "files": ["A - B.mp3"]}],
  "started_at": "2026-09-21T12:00:00+03:00",
  "finished_at": null
}
```

Правила записи:

- `ProgressStore::reset($runId)` кладёт «чистый» лист (blank) со `status=running`.
- `update(array $patch)` делает `array_merge` поверх прочитанного состояния; ключ `log` в патче **всегда игнорируется** — журнал меняется только через `log()` (так никто случайно не затрёт историю).
- `write()` — `file_put_contents` во `progress.json.tmp` + `rename`. Читатели видят либо старую, либо новую версию, никогда — обрезанную.
- Журнал усекается до 500 записей.

### 3.2 `storage/tracks.json`

Ключ — имя файла в нижнем регистре, значение — результат:

```
{ "a - b.mp3": { "status": "done", "bpm": 128, "key": "Am", "duration": 214.5, "updated_at": "…" } }
{ "broken.mp3": { "status": "error", "message": "…", "updated_at": "…" } }
```

`TracksIndex::buildRows(array $inboxFiles)` соединяет текущие файлы `inbox/` с этим кэшем и вытаскивает из имён `Исполнитель — Название` (`parseTrackName`): убирается ведущий числовой префикс DJ-разметки (`01 - `), `-` вокруг пробелов/подчёркиваний считается разделителем.

### 3.3 Ответ `get_inbox`

```
{ "status": "ok",
  "rows": [ { "name": "A - B.mp3", "title": "B", "artist": "A",
              "bpm": 128|null, "key": "Am"|null, "duration": 214.5|null,
              "status": "pending|done|error", "message": null|"…" } ] }
```

### 3.4 События SSE (`stream_analyze`)

`event: <имя>` + `data: <json>`:

| Событие | Полезная нагрузка | Комментарий |
|---|---|---|
| `idle` | `{message}` | inbox пуст/нет аудио |
| `already_running` | `{message, state}` | параллельный запуск отклонён (мёртвый `running` старше 30 мин — разрешён) |
| `log` | `{time, type, message}` | дубль строки журнала |
| `track_start` | `{index, name, total}` | начало файла |
| `track_progress` | `{name, progress, phase}` | 0..1 от Python |
| `track_done` | `{name, bpm, key, folder, duration}` | успех + перекладывание |
| `track_error` | `{name, message}` | ошибка файла (цепочка продолжается) |
| `progress` | `{processed, total}` | агрегат для верхней полосы |
| `done` | `{status, sorted, processed, total, folders, run_id}` | завершение прогона |
| `error` | `{message}` | фатальная ошибка PHP |

### 3.5 Фолбэк `analyze_inbox`

Тот же `AnalysisRunner::run()`, но без стрима: один JSON-ответ `{status, sorted, processed, total, folders, run_id}`. `Http::jsonResponse` вызывает `exit` — тип `never`.

---

## 4. Фронтенд (ES-модули)

### 4.1 Порядок сборки и зависимости

`tools/build.js` склеивает модули в таком порядке (порядок важен — это плоский бандл без импортов):

```
store → utils → player → table → sort → views → upload → analysis → main
```

Зависимости между модулями:

- `utils` ← `store`, `views`, `player`, `upload`, `analysis`, `main`
- `table` ← `store`, `utils`, `player`
- `sort` ← `store`, `table` (поэтому `updateSortInd` лежит в `table.js`, а не в `sort.js` — иначе цикл sort↔table)
- `views` ← `store`, `utils`, `table`
- `upload` ← `store`, `utils`, `views`
- `analysis` ← `store`, `utils`, `table`, `views`, `upload`
- `main` ← всё

### 4.2 Центральное состояние (`store.js`)

```
state = {
  rows,                 // строки из get_inbox
  rowRefs: Map,         // name -> {tr, nameCell, bpmCell, keyCell, durCell,
                        //          playBtn, playWrapper, playFill, playTime, playBar}
  sort,                 // { key: 'num'|'track'|'bpm'|'key'|'duration', dir: 1|-1|0 }
  mode,                 // 'idle' | 'processing' | 'poll' | 'done'
  es,                   // текущий EventSource
  pollTimer, liveTimer, // таймеры фолбэка и live-опроса
  fallbackFired,        // страховка, чтобы фолбэк запускал analyze_inbox один раз
  stopping,             // кнопка «Стоп» нажата
  renderedLogs,         // сколько записей журнала уже отрисовано
  play: { audio, name } // экземпляр Audio + имя играющего трека
}
```

Терминальные состояния (по ним останавливаем опрос): `complete`, `error`, `stopped` — `TERMINAL_STATES`.

### 4.3 Потоки

**Загрузка** (`upload.js`): FormData → `upload` → `refreshInbox()`. Если файлов нет — вью «загрузка», иначе — таблица.

**Анализ — основной путь** (`analysis.js`):
`startProcessing()` → `EventSource(analysisApi.php?action=stream_analyze)` + `startLivePoll()` (каждые 500 мс `get_progress` как страховка от буферизации). События парсятся и отправляются в `table.js`-функции. На `done` — баннер + `refreshInbox()`.

**Анализ — фолбэк** (`startPolling(launchAnalysis)`):
если SSE оборвался (`es.onerror` → `fallbackToPolling` → `startPolling(true)`, однократно запускает `analyze_inbox`), дальше работаем только по `get_progress` каждые `POLL_INTERVAL=2000` мс. Тот же путь, если при загрузке страницы уже идёт анализ в другом окне (`startPolling(false)` — без запуска).

**Строки таблицы** (`table.js`):
- `renderTable` — полная перерисовка по `get_inbox` (после загрузки/сортировки/завершения).
- `rowProcessing(name)` — строка в состояние «анализирую»: бегущая полоска + `cell-status` + play-bar.
- `rowProgress/rowDone/rowError` — live-обновление. Все ветки аккуратно пересобирают `nameCell`, поэтому переживают ре-рендер: playBtn и playWrapper сохраняются из `rowRefs`.
- `rebuildRowIdle` — возврат строки в «ожидание» (при повторном старте).

**Плеер** (`player.js`): один глобальный `Audio` (`state.play.audio`). Кнопка-кружок (`play-btn`) с CSS-треугольником; в состоянии воспроизведения — градиент + две паузы через `display:flex` (не box-shadow). Прогресс-бар виден в каждой строке сразу; время/заливка появляются после `loadedmetadata`. Перетаскивание по `.play-bar` через `setPointerCapture` (`bindSeek`), работает только если бар принадлежит играющему треку. `applyPlaybackState` восстанавливает иконку после перерисовки таблицы. Ошибка воспроизведения — запись в журнал. Тумблер «Подряд» (`#queue-check`, Apple-стиль в `components.css`): по событию `ended` `playNextInQueue()` берёт следующий трек из `state.rows` (текущий порядок таблицы, с зацикливанием) и запускает `togglePlay()`.

**Сортировка** (`sort.js`): `num` — по имени файла, `bpm`/`duration` — числовые, `key` — строковая; `track` — перемешивание (Fisher–Yates). Пересортировка отключена в режимах `processing`/`poll`.

### 4.4 CSS

Три файла (подробно в разделе 2). Ключевое: дублей селекторов нет; `@keyframes shimmer/blink` в `base.css`; canonical-блок плеера — в `table.css` (height 6px, glow `rgba(124,92,255,.5)`, transition width `.25s linear`); `@media (max-width:700px)` в самом конце `table.css`.

Нюансы:
- `.col-track` задаёт только `min-width`; flex-раскладка (`display:flex; align-items:center`) вынесена в отдельный селектор `td.col-track` — если включить flex и на заголовке `<th>`, табличная раскладка считает ширину колонки на ~1–2px иначе, и шапка «Трек и исполнитель» визуально расползается.
- Тумблер «Подряд» (`.queue-toggle` + `.q-slider` в `components.css`) — скрытый чекбокс в `<label>`: белый «шарик» сдвигается на `translateX(18px)`, фон красится в `--success`; фокус-ринг для клавиатуры через `input:focus-visible + .q-slider`.

---

## 5. Python-анализатор (`scripts/analyzer.py`)

### 5.1 Запуск

```
python analyzer.py <абсолютный путь к треку> [файл-прогресса.json]
```

- Не получил файл → `{"status":"error","message":…}` в stdout, exit 1.
- Только последняя непустая строка stdout парсится как JSON (предупреждения/numpy-мусор не мешают).
- `sys.stdout.reconfigure(encoding="utf-8")` — иначе на Windows в pipe уйдёт ANSI-кодовая страница и кириллица разобьёт JSON.
- В середине пайплайна — по одному `.json` с `{"status":...}` результата; `AnalysisService::parseStdout` берёт последнюю строку.

### 5.2 Стадии (прогресс пишется в файл фоновым потоком каждые 150 мс)

| `reporter.target` | Фаза |
|---|---|
| 0.04 | инициализация |
| 0.55 | загрузка аудио (первые 30 сек, `librosa.load(sr=22050, mono)`) |
| 0.80 | определение BPM (`librosa.beat.beat_track`, `hop_length=256`) |
| 0.93 | определение тональности (`chroma_cqt` × профили Крамхансла–Шмюклера, 12×2 корреляций) |
| 0.97 | метаданные (`mutagen`, easy=True) |
| 1.0 | готово |

`ProgressReporter` плавно подтягивает `value → target` (коэффициент 0.35), чтобы фронт видел анимацию, а не скачки. Файл прогресса пишется через `tmp` + `os.replace` (атомарно, как и на PHP).

### 5.3 Ошибки

- Пустой сигнал в первых 30 секундах → `ValueError` → `{"status":"error"}`.
- Метаданные не критичны: `read_metadata` глотает исключения, поля остаются `null`.
- Ошибка инициализации numpy/librosa → сообщение об отсутствующих зависимостях, exit 1.

---

## 6. PHP-бэкенд по классам

### `analysisApi.php` (роутер модуля «Обработка»)

`match($action)` вызывает `handle*`-функции. `ignore_user_abort(true)` и `set_time_limit(STEMPLAYER_MAX_EXEC_TIME)` — чтобы стрим не оборвался при закрытии клиента. Список действий — в README (раздел API). Константу `api.base` в `store.js` менять при переименовании API-файла модуля.

### `core/Http.php`

- `sseHeaders()` — gzip off, очистка `ob_*`, `text/event-stream`, `X-Accel-Buffering: no`.
- `sseEmit(event, payload)` — один `event:`/`data:` блок + `flush()`.
- `jsonResponse(payload): never` — JSON и `exit`.

### `core/PythonRunner.php`

`run(script, cliArgs, ?onProgress, ?stopCheck): {stdout, stderr, exit_code, terminated}`:

1. Собирает `cmd = [python, script, ...args, progress.json?]`, `cwd = корень проекта`.
2. `proc_open` без `env` (см. раздел 1, п. 2); pipes переведены в non-blocking.
3. Цикл: `pollProgressFile` (+ опциональный stopCheck, `usleep(20_000)`), `proc_get_status`.
4. Остановка → `terminate()` (`taskkill /PID /T /F` на Windows) → `stopped = true`.
5. После выхода процесса: pipes переведены в blocking, вычитываются stdout/stderr, последний раз опрашивается прогресс-файл.
6. Временный прогресс-файл и его `.tmp` всегда удаляются в `finally`.

### `AnalysisService.php`

`runAnalysis(filePath, ?onProgress, ?stopCheck)` — тонкая обёртка над `PythonRunner`:

1. Проверка файла → `run(self::SCRIPT, [$filePath], ...)`.
2. `terminated`/`exit_code === -1` → «Анализ прерван пользователем».
3. `parseStdout` — последняя строка файла с валидным JSON; `stderr` прикладывается только к ответам с ошибкой.

Старые `PROGRESS`-строки из stderr убраны: прогресс живёт только в JSON-файле. Все описания proc_open/пайпов живут в `core/PythonRunner.php` — каждый модуль получает его бесплатно.

### `AnalysisRunner.php`

`run(store, files, streaming=false)` — цикл по `collectInboxFiles()`:

- `reset($runId)` → `update(total, stop_requested:false)`.
- На каждый файл: логирование, `track_start`, колбэк прогресса (пишет `live` в store с троттлингом 0.4 c), `stopCheck`.
- Четыре ветки ошибок (Throwable, status≠success, пустые BPM/Key, неудачный `moveToSorted`) — все сохраняют `tracks.json`, пишут журнал и шлют `track_error`, **не прерывая цикл**.
- Успех: `moveToSorted()` + `tracks.json` + `track_done`.
- Финал: `folders` от `listSortedFolders()`, `status=complete|stopped`, журнал, `done`.
- `stopRequested()` читает флаг из store; `isRunningNotStale($startedAt)` — разрешает запуск, если «running» старше 30 минут (после краха сервера).

### `TracksIndex.php`

Кэш результатов; `buildRows` собирает строки таблицы; `parseTrackName` разбирает `Исполнитель — Название` и DJ-префиксы; `prettify` заменяет подчёркивания на пробелы.

### `FileSorter.php`

`sanitizeFolderName("128", "C#m")` → `BPM128_KeyCsM`:
`#→s`, `b→f`, `major→(пусто)`, `minor→m`, минорный суффикс в верхний регистр, `- / пробелы → _`.

`moveToSorted` — `copy()` исходник из inbox в `music/sorted/BPM…_Key…/` (исходный файл в inbox остаётся). `listSortedFolders` — дерево для баннера.

### `UploadService.php`

`handle(?array $files, string $inboxDir)`:
- Пустое поле files → ошибка `post_max_size`-подсказкой.
- Ошибки PHP-загрузки (`UPLOAD_ERR_*`) → в `rejected` с человеческим текстом.
- Проверка расширения по `STEMPLAYER_AUDIO_EXT` → rejected.
- `sanitizeUploadName` (недопустимые символы Windows → `_`) + `uniqueInboxPath` (суффиксы `_1`, `_2`…).
- Ответ: `{status:ok, uploaded:[…], rejected:[{name, reason}]}`.

### `ProgressStore.php`

См. раздел 3.1. Отдельно: `update()` всегда игнорирует ключ `log`; `blank()` задаёт полную схему файла (`stop_requested`, `live` и т.д.), чтобы ответ `get_progress` был стабильным.

---

## 7. Сборка и проверки

### Бандл JS

```
node tools/build.js     → analysis/assets/js/sorter.min.js (9 модулей)
```

Для dev-режима `analysis/index.html` подключает `assets/js/main.js` (модуль), для прод — `sorter.min.js`.

### Быстрые проверки после изменений

```
node --check analysis/assets/js/*.js               # синтаксис JS-модулей
node --check analysis/assets/js/sorter.min.js      # бандл (esm плоский, --check ок)
php -l core/*.php analysis/analysisApi.php analysis/classes/*.php
python -m py_compile analysis/scripts/analyzer.py

# smoke-тест API (только на Apache!)
curl -s "http://127.0.0.1/StemPlayer/analysis/analysisApi.php?action=get_inbox"
curl -s "http://127.0.0.1/StemPlayer/analysis/analysisApi.php?action=get_progress"
```

SSE тестировать на Apache, не на `php -S` (однопоточность ломает параллельный поллинг). При тесте полного цикла очищайте `storage/progress.json` от «мёртвого» `running`.

---

## 8. Куда смотреть при правках

| Хочется… | Идти в… |
|---|---|
| Поменять фазы/прогресс анализа | `analysis/scripts/analyzer.py` (`ProgressReporter`, `reporter.target`) |
| Новый тип события в стриме | `AnalysisRunner` (эмит) + `analysis.js` (обработчик) |
| Новая колонка таблицы | `analysis/index.html` (th) + `table.js` + `store.js` rowRefs + CSS |
| Сообщения журнала | `ProgressStore::log` + `AnalysisRunner` |
| Часовая логика запуска python | `core/PythonRunner.php` |
| Лимиты загрузки | `.htaccess` |
| Исполняемый python | `config.php` / env `STEMPLAYER_PYTHON` |
| Дизайн плеера | `analysis/assets/css/table.css`: блок `.play-*` (единственное место) |
| Дизайн тумблера «Подряд» | `analysis/assets/css/components.css`: `.queue-toggle` / `.q-slider` |
| Логика очереди «Подряд» | `analysis/assets/js/player.js`: `playNextInQueue()` + обработчик `ended` |
| Новый модуль проекта | первое: `core/` даёт Http/ProgressStore/PythonRunner; затем папка модуля + `{модуль}Api.php` + `index.html` |