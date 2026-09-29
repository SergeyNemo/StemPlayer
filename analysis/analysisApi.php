<?php

declare(strict_types=1);

/**
 * API модуля «Обработка» (analysis).
 *
 * Доступные действия:
 *   analysisApi.php?action=start_analysis — запуск фоновой обработки inbox (CLI-демон, независим от страницы)
 *   analysisApi.php?action=get_progress   — состояние демона из storage/progress.json (+ stemgen_running)
 *   analysisApi.php?action=get_folders    — дерево папок music/sorted/
 *   analysisApi.php?action=get_inbox      — строки таблицы треков (inbox + кэш результатов, + stemgen_running)
 *   analysisApi.php?action=upload         — POST multipart: загрузка треков в inbox/
 *   analysisApi.php?action=delete_track   — POST name=<файл>: удалить трек из inbox/ вместе с копией, стемами и записями storage/
 *   analysisApi.php?action=stop_analysis  — запрос остановки текущего анализа
 *
 * Модуль работает только через CLI-демон и опрос состояния, поэтому синхронных
 * и SSE-действий здесь нет.
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../core/Http.php';
require_once __DIR__ . '/../core/FileLog.php';
require_once __DIR__ . '/../core/ProgressStore.php';
require_once __DIR__ . '/../core/RunState.php';
require_once __DIR__ . '/../core/SpawnCli.php';
require_once __DIR__ . '/../core/PythonRunner.php';
require_once __DIR__ . '/classes/AnalysisInterface.php';
require_once __DIR__ . '/classes/SortingInterface.php';
require_once __DIR__ . '/classes/FileSorter.php';
require_once __DIR__ . '/classes/TracksIndex.php';
require_once __DIR__ . '/classes/AnalysisService.php';
require_once __DIR__ . '/classes/UploadService.php';
require_once __DIR__ . '/classes/AnalysisRunner.php';
require_once __DIR__ . '/classes/TrackCleaner.php';

// Long-running запросы не должны обрываться клиентом или сервером.
ignore_user_abort(true);
set_time_limit(0);
if (STEMPLAYER_MAX_EXEC_TIME > 0) {
    set_time_limit(STEMPLAYER_MAX_EXEC_TIME);
}

$action        = (string) ($_GET['action'] ?? '');
$progressStore = new ProgressStore();
$inboxDir      = __DIR__ . '/../music/inbox';
$flog          = new FileLog(null, 'analysis-api');

match ($action) {
    'start_analysis' => handleStartAnalysis($progressStore, $inboxDir, $flog),
    'get_progress'   => handleGetProgress($progressStore),
    'get_folders'    => handleGetFolders(),
    'get_inbox'      => handleGetInbox($inboxDir),
    'upload'         => handleUpload($inboxDir),
    'delete_track'   => handleDeleteTrack($inboxDir, $progressStore, $flog),
    'stop_analysis'  => handleStopAnalysis($progressStore, $flog),
    default          => Http::jsonResponse(['error' => 'Неизвестное действие: ' . $action]),
};

/**
 * Запуск фоновой обработки: страница не обязана оставаться открытой —
 * работу делает отдельный CLI-демон, а фронт лишь опрашивает прогресс.
 */
function handleStartAnalysis(ProgressStore $store, string $inboxDir, FileLog $flog): never
{
    $state = $store->read();
    $runner = new AnalysisRunner();

    if (($state['status'] ?? '') === 'running' && RunState::isFresh($state)) {
        Http::jsonResponse(['status' => 'already_running', 'message' => 'Анализ уже выполняется.', 'started' => false]);
    }

    // Взаимная блокировка: пока генерируются стемы, обработку не запускаем.
    if (RunState::otherModuleRunning(RunState::ANALYSIS)) {
        Http::jsonResponse(['status' => 'blocked', 'message' => 'Сейчас выполняется генерация стемов — запустите обработку после её завершения.', 'started' => false]);
    }

    if ($runner->collectInboxFiles($inboxDir) === []) {
        Http::jsonResponse(['status' => 'idle', 'message' => 'В папке inbox/ нет файлов для обработки.', 'started' => false]);
    }

    // Эксклюзивный захват на момент запуска: два окна не поднимут два демона.
    $lockPath = __DIR__ . '/../storage/analysis_start.lock';
    $lock = @fopen($lockPath, 'c');

    if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
        Http::jsonResponse(['status' => 'already_running', 'message' => 'Обработка уже запускается.', 'started' => false]);
    }

    $spawnLog = __DIR__ . '/../logs/spawn-analysis.log';
    $beforeRunId = (string) ($state['run_id'] ?? '');
    $beforePing = (int) ($state['last_ping'] ?? 0);

    try {
        $spawn = SpawnCli::spawn(__DIR__ . '/cli/analyze_cli.php', $spawnLog);

        if (!$spawn['ok']) {
            $flog->write('error', 'Не удалось запустить демон: ' . ($spawn['error'] ?? 'неизвестная причина'));
            Http::jsonResponse(['status' => 'error', 'message' => $spawn['error'] ?? 'Не удалось запустить фоновый процесс.', 'started' => false]);
        }

        // Демон обязан «подать признаки жизни» в progress.json (новый run_id).
        // Если за 4 секунды тишина — значит процесс умер, показываем причину.
        $alive = false;

        for ($i = 0; $i < 20; $i++) {
            usleep(200_000);
            $now = $store->readFresh();

            if ((string) ($now['run_id'] ?? '') !== $beforeRunId
                || (int) ($now['last_ping'] ?? 0) > $beforePing) {
                $alive = true;
                break;
            }
        }

        if (!$alive) {
            $tail = SpawnCli::logTail($spawnLog);
            $flog->write('error', 'Демон не подал признаков жизни за 4 с.' . ($tail !== '' ? ' Вывод: ' . $tail : ' Лог демона пуст.'));
            Http::jsonResponse([
                'status'  => 'error',
                'started' => false,
                'message' => 'Фоновый процесс не запустился. ' . ($tail !== '' ? 'Вывод: ' . $tail : 'Смотри logs/spawn-analysis.log.'),
            ]);
        }
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }

    $flog->write('info', 'Запущена фоновая обработка (CLI-демон).');
    Http::jsonResponse(['status' => 'started', 'message' => 'Обработка запущена.', 'started' => true]);
}

function handleGetProgress(ProgressStore $store): never
{
    $data = $store->read();
    $data['stemgen_running'] = RunState::otherModuleRunning(RunState::ANALYSIS);

    Http::jsonResponse($data);
}

function handleGetFolders(): never
{
    $sorter = new FileSorter();

    Http::jsonResponse([
        'status'  => 'ok',
        'folders' => $sorter->listSortedFolders(),
    ]);
}

/**
 * Возвращает строки таблицы: текущие файлы inbox/ вместе с кэшем анализа.
 */
function handleGetInbox(string $inboxDir): never
{
    $index = new TracksIndex();
    $runner = new AnalysisRunner();

    Http::jsonResponse([
        'status'          => 'ok',
        'rows'            => $index->buildRows($runner->collectInboxFiles($inboxDir)),
        'stemgen_running' => RunState::otherModuleRunning(RunState::ANALYSIS),
    ]);
}

/**
 * Удаление трека «отовсюду»: исходник из inbox/, копия и стемы из
 * music/sorted/, записи из storage/. Подтверждение — на странице (delete.js).
 */
function handleDeleteTrack(string $inboxDir, ProgressStore $store, FileLog $flog): never
{
    $name = trim((string) ($_GET['name'] ?? $_POST['name'] ?? ''));

    if ($name === '') {
        Http::jsonResponse(['status' => 'error', 'message' => 'Не указан трек для удаления.']);
    }

    // Живой демон держит в памяти список файлов, собранный при старте, и ждёт
    // их на диске: удаление трека посреди прогона роняет его именно на этом
    // треке. Поэтому на странице кнопки гаснут на время работы, а здесь та же
    // проверка — на случай второго окна или подделанного запроса.
    $state = $store->read();

    if (($state['status'] ?? '') === 'running' && RunState::isFresh($state)) {
        Http::jsonResponse([
            'status'  => 'error',
            'message' => 'Идёт обработка — дождитесь окончания, потом удалите трек.',
        ]);
    }

    try {
        $report = (new TrackCleaner($inboxDir))->delete($name);
    } catch (InvalidArgumentException $e) {
        Http::jsonResponse(['status' => 'error', 'message' => $e->getMessage()]);
    }

    $flog->write('info', sprintf(
        'Удалён трек «%s»: inbox %s, копий %d, каталогов стемов %d, папок %d, tracks.json %s.',
        $report['name'],
        $report['inbox'] ? 'удалён' : 'не было',
        $report['copies'],
        $report['stems'],
        $report['folders'],
        $report['tracks_index'] ? 'чищен' : 'без записи',
    ));

    Http::jsonResponse([
        'status'  => 'ok',
        'deleted' => $report,
        'message' => deleteMessage($report),
    ]);
}

/**
 * Человеческое подтверждение удаления: перечисляем, что именно снесено, —
 * по отчёту TrackCleaner, а не по предположению.
 *
 * @param array{name: string, inbox: bool, copies: int, stems: int, folders: int, tracks_index: bool, progress: array<string, mixed>} $report
 */
function deleteMessage(array $report): string
{
    if (!$report['inbox']) {
        return sprintf('«%s»: файла в Inbox уже не было, хранилище очищено.', $report['name']);
    }

    $parts = ['исходник из Inbox'];

    if ($report['copies'] > 0) {
        $parts[] = 'копия в music/sorted';
    }

    if ($report['stems'] > 0) {
        $parts[] = 'каталоги стемов (' . $report['stems'] . ')';
    }

    if ($report['tracks_index']) {
        $parts[] = 'запись из storage/tracks.json';
    }

    $progress = $report['progress'];
    $touched  = is_array($progress) ? array_filter([
        $progress['done'] ?? false,
        $progress['error'] ?? false,
        $progress['current'] ?? false,
        ($progress['folders'] ?? 0) > 0,
    ]) : [];

    if ($touched !== []) {
        $parts[] = 'состояние прогона (progress.json)';
    }

    return sprintf('«%s» удалён: %s.', $report['name'], implode(', ', $parts));
}

/**
 * POST multipart (поле files[]): кладёт загруженные треки в inbox/.
 */
function handleUpload(string $inboxDir): never
{
    Http::jsonResponse((new UploadService())->handle($_FILES['files'] ?? null, $inboxDir));
}

function handleStopAnalysis(ProgressStore $store, FileLog $flog): never
{
    $state = $store->read();

    if ((($state['status'] ?? '') !== 'running')) {
        $flog->write('warning', 'Остановка запрошена, но анализ не выполняется.');
        Http::jsonResponse(['status' => 'idle', 'message' => 'Анализ сейчас не выполняется.']);
    }

    $flog->write('info', 'Запрошена остановка анализа.');
    $store->requestStop();

    Http::jsonResponse(['status' => 'ok', 'message' => 'Останавливаем анализ…']);
}