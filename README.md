# StemPlayer — сортировка треков по BPM и тональности

Модульная система. Пока готов один модуль — **«Обработка»** (`analysis/`): загружаете аудиотреки, нажимаете «Обработать» — сервер анализирует каждый файл (темп, тональность, метаданные) и раскладывает их по папкам `music/sorted/BPM{число}_Key{тональность}/`. Прямо из таблицы треки можно прослушать и перемотать. Модуль **«Стемы»** (`stemgen/`, разделение на вокал/бас/ударные/остальное через Demucs) — в плане.

## Возможности

- **Загрузка** — drag-and-drop или выбор файлов (mp3, wav, flac, ogg, aac, m4a, wma, aiff, aif; до 300 МБ на файл). Дубликаты по имени автоматически получают суффикс `_1`, `_2`, …
- **Анализ** — для каждого файла определяется BPM (по первым 30 секундам), тональность (корреляция хромы с профилями Крамхансла–Шмюклера), длительность и метаданные (title/artist/album), если они есть в тегах.
- **Живой прогресс** — SSE-поток событий в реальном времени + подстраховка опросом `progress.json` каждые 500 мс (на случай буферизации стрима). По каждому треку видно фазу и проценты прямо в строке таблицы.
- **Остановка** — кнопка «Стоп» прерывает анализ текущего трека и обработанные файлы сохраняются.
- **Сортировка/перемешивание** — клик по заголовкам колонок (№, BPM, тональность, длительность), по «Трек и исполнитель» — перемешать.
- **Плеер в таблице** — круглая кнопка «прослушать», прогресс-бар с перемоткой перетаскиванием; играет только один трек одновременно.
- **Очередь «Подряд»** — тумблер в стиле Apple включает автоматическое воспроизведение следующего трека по окончании текущего (по текущему порядку в таблице).
- **Журнал** — сворачиваемый диагностический лог всех операций (загрузка, анализ, ошибки).
- **Итог** — после завершения баннер показывает, сколько файлов разложено, и интерактивное дерево папок `music/sorted/`.
- **Кэш результатов** — результаты анализа хранятся в `storage/tracks.json`, поэтому после перезагрузки страницы BPM/Key/длительность видны без повторного анализа.

## Установка и запуск

Требуется:

- **Apache + PHP 8.1+** (например, XAMPP). Проект работает по HTTP — как ES-модули фронтенда, так и SSE не работают через `file://`.
- **Python 3.9+** с зависимостями анализатора:

```
pip install numpy librosa mutagen
```

Зависимости можно проверить/поставить только используемым частям: `librosa` тянет `numba` и `audioread`.

### Шаги

1. Скопируйте папку проекта в `C:\xampp\htdocs\StemPlayer` (или в корень любого другого виртуального хоста).
2. Убедитесь, что `python` доступен из PATH, или укажите полный путь в `config.php` (переменная `STEMPLAYER_PYTHON`).
3. Откройте в браузере:

```
http://127.0.0.1/StemPlayer/
```

4. Первый запуск: перетащите треки в дропзону → нажмите «Обработать».

При первом обращении будут созданы папки `music/inbox/` и `music/sorted/` (если их нет).

## Конфигурация (`config.php`)

| Константа | Значение по умолчанию | Описание |
|---|---|---|
| `STEMPLAYER_PYTHON` | `python` (или env) | Исполняемый файл Python; переопределяется переменной окружения `STEMPLAYER_PYTHON` |
| `STEMPLAYER_MAX_EXEC_TIME` | `0` | Лимит времени long-running операций, сек (0 = без ограничения) |
| `STEMPLAYER_AUDIO_EXT` | 9 расширений | Какие файлы считать аудио |

Лимиты загрузки — в `.htaccess` (`upload_max_filesize`, `post_max_size`, `max_file_uploads`, `max_execution_time`).

## Как это работает (кратко)

```
Браузер (ES-модули)  →  analysis/analysisApi.php (API модуля)  →  analysis/classes/*.php + core/*.php  →  analysis/scripts/analyzer.py (python)
```

1. Загрузка файлов в `analysisApi.php?action=upload` → `music/inbox/`.
2. «Обработать» → `analysisApi.php?action=stream_analyze` открывает SSE-соединение.
3. PHP по очереди запускает `analyzer.py` для каждого файла; python пишет живой прогресс в временный JSON-файл, PHP опрашивает его и шлёт события `track_start/track_progress/track_done/track_error`.
4. Успешные треки копируются в `music/sorted/BPM{число}_Key{тональность}/`, результат — в `storage/tracks.json`.
5. Если SSE-поток оборвался, фронтенд автоматически переключается на опрос `analysisApi.php?action=get_progress`.

Цикл запуска python (proc_open + опрос JSON-файла прогресса) вынесен в `core/PythonRunner.php` и общий для всех модулей.

## Структура проекта

```
StemPlayer/
├── index.php              # посадочная страница со списком модулей (http://host/StemPlayer/)
├── config.php             # глобальная конфигурация
├── .htaccess              # лимиты загрузки и время выполнения
├── core/                  # общее ядро для модулей
│   ├── Http.php           #   JSON-ответы, ошибки, SSE-поток
│   ├── ProgressStore.php  #   чтение/запись storage/progress.json (атомарно)
│   └── PythonRunner.php   #   запуск python-скриптов с живым прогрессом и стопом
├── analysis/              # модуль «Обработка»
│   ├── index.html         #   страница модуля (бывший sorter.html)
│   ├── analysisApi.php    #   API модуля («имя модуля» + Api.php)
│   ├── classes/           #   AnalysisService, AnalysisRunner, FileSorter,
│   │                      #     TracksIndex, UploadService + интерфейсы
│   ├── assets/            #   css/ (base, components, table) + js/ (9 ES-модулей
│   │                      #     и sorter.min.js для продакшена)
│   ├── scripts/analyzer.py#   python-анализатор (BPM/Key/метаданные)
│   └── music/             #   inbox/ (сюда загружаются треки), sorted/ (результат)
├── stemgen/               # модуль «Стемы» — запланирован
├── tools/build.js         # билдер одного JS-файла (Node)
└── storage/               # служебные JSON: progress.json, tracks.json
```

Интерфейсы модуля — в `analysis/classes/AnalysisInterface.php` и `SortingInterface.php`; ядро в `core/` их не знает и наоборот.

## API

Все запросы через GET-параметр `action=…` к `analysis/analysisApi.php`:

| action | Метод | Описание |
|---|---|---|
| `stream_analyze` | GET | SSE-поток анализа (события `idle`, `already_running`, `log`, `track_start`, `track_progress`, `track_done`, `track_error`, `progress`, `done`, `error`) |
| `analyze_inbox` | GET | Анализ одним JSON-ответом (фолбэк для простых клиентов) |
| `get_progress` | GET | Текущее состояние `storage/progress.json` |
| `get_folders` | GET | Дерево `music/sorted/` |
| `get_inbox` | GET | Строки таблицы (файлы inbox + кэш результатов) |
| `upload` | POST | multipart, поле `files[]` — загрузка треков |
| `stop_analysis` | GET | Запросить остановку текущего анализа |

Пример загрузки:

```
curl -F "files[]=@track.mp3" "http://127.0.0.1/StemPlayer/analysis/analysisApi.php?action=upload"
```

## Прод-режим

Фронтенд собран в один файл (`analysis/assets/js/sorter.min.js`), но по умолчанию страница использует дев-модули. Чтобы переключиться на собранный файл, замените в `analysis/index.html`:

```html
<script type="module" src="assets/js/main.js"></script>
```

на:

```html
<script type="module" src="assets/js/sorter.min.js"></script>
```

Пересборка после изменений в JS: `node tools/build.js`.

## Подробнее о внутреннем устройстве

Архитектура, потоки данных, ключевые решения (Windows-специфика) и пошаговое описание каждого модуля — в [TECH.md](TECH.md).