<?php

declare(strict_types=1);

/**
 * API модуля «Обработка» (analysis).
 *
 * Доступные действия:
 *   analysisApi.php?action=stream_analyze — SSE-стрим: анализ + живые события реального времени
 *   analysisApi.php?action=analyze_inbox  — анализ одним ответом (фолбэк для простых клиентов)
 *   analysisApi.php?action=get_progress   — текущий прогресс из storage/progress.json
 *   analysisApi.php?action=get_folders    — дерево папок music/sorted/
 *   analysisApi.php?action=get_inbox      — строки таблицы треков (inbox + кэш результатов)
 *   analysisApi.php?action=upload         — POST multipart: загрузка треков в inbox/
 *   analysisApi.php?action=stop_analysis  — запрос остановки текущего анализа
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../core/Http.php';
require_once __DIR__ . '/../core/ProgressStore.php';
require_once __DIR__ . '/../core/PythonRunner.php';
require_once __DIR__ . '/classes/AnalysisInterface.php';
require_once __DIR__ . '/classes/SortingInterface.php';
require_once __DIR__ . '/classes/FileSorter.php';
require_once __DIR__ . '/classes/TracksIndex.php';
require_once __DIR__ . '/classes/AnalysisService.php';
require_once __DIR__ . '/classes/UploadService.php';
require_once __DIR__ . '/classes/AnalysisRunner.php';

// Long-running запросы не должны обрываться клиентом или сервером.
ignore_user_abort(true);
set_time_limit(0);
if (STEMPLAYER_MAX_EXEC_TIME > 0) {
    set_time_limit(STEMPLAYER_MAX_EXEC_TIME);
}

$action        = (string) ($_GET['action'] ?? '');
$progressStore = new ProgressStore();
$inboxDir      = __DIR__ . '/../music/inbox';

match ($action) {
    'stream_analyze' => handleStreamAnalyze($progressStore, $inboxDir),
    'analyze_inbox'  => handleAnalyzeInbox($progressStore, $inboxDir),
    'get_progress'   => handleGetProgress($progressStore),
    'get_folders'    => handleGetFolders(),
    'get_inbox'      => handleGetInbox($inboxDir),
    'upload'         => handleUpload($inboxDir),
    'stop_analysis'  => handleStopAnalysis($progressStore),
    default          => Http::jsonResponse(['error' => 'Неизвестное действие: ' . $action]),
};

function handleStreamAnalyze(ProgressStore $store, string $inboxDir): never
{
    Http::sseHeaders();

    $state = $store->read();
    $runner = new AnalysisRunner();

    if (($state['status'] ?? '') === 'running' && $runner->isRunningNotStale((string) $state['started_at'])) {
        Http::sseEmit('already_running', ['message' => 'Анализ уже выполняется в другом подключении.', 'state' => $state]);
        exit;
    }

    try {
        $files = $runner->collectInboxFiles($inboxDir);

        if ($files === []) {
            Http::sseEmit('idle', ['message' => 'Папка inbox/ пуста или не содержит аудиофайлов.']);
            exit;
        }

        $summary = $runner->run($store, $files, streaming: true);

        Http::sseEmit('done', $summary);
    } catch (Throwable $e) {
        $store->log('error', 'Фатальная ошибка: ' . $e->getMessage());
        $store->update(['status' => 'error']);

        Http::sseEmit('error', ['message' => $e->getMessage()]);
    }

    exit;
}

/**
 * Классический ответ JSON (используется фолбэком и внешними клиентами).
 */
function handleAnalyzeInbox(ProgressStore $store, string $inboxDir): never
{
    $state = $store->read();
    $runner = new AnalysisRunner();

    if ($state['status'] === 'running' && $runner->isRunningNotStale((string) $state['started_at'])) {
        Http::jsonResponse([
            'status'  => 'running_already',
            'message' => 'Анализ уже выполняется. Дождитесь завершения.',
            'state'   => $state,
        ]);
    }

    try {
        $files = $runner->collectInboxFiles($inboxDir);

        if ($files === []) {
            Http::jsonResponse(['status' => 'idle', 'message' => 'Папка inbox/ пуста или не содержит аудиофайлов.']);
        }

        $summary = $runner->run($store, $files);

        Http::jsonResponse($summary);
    } catch (Throwable $e) {
        $store->log('error', 'Фатальная ошибка: ' . $e->getMessage());
        $store->update(['status' => 'error']);

        Http::jsonResponse(['status' => 'error', 'message' => $e->getMessage()]);
    }
}

function handleGetProgress(ProgressStore $store): never
{
    Http::jsonResponse($store->read());
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
        'status' => 'ok',
        'rows'   => $index->buildRows($runner->collectInboxFiles($inboxDir)),
    ]);
}

/**
 * POST multipart (поле files[]): кладёт загруженные треки в inbox/.
 */
function handleUpload(string $inboxDir): never
{
    Http::jsonResponse((new UploadService())->handle($_FILES['files'] ?? null, $inboxDir));
}

function handleStopAnalysis(ProgressStore $store): never
{
    $state = $store->read();

    if (($state['status'] ?? '') !== 'running') {
        Http::jsonResponse(['status' => 'idle', 'message' => 'Анализ сейчас не выполняется.']);
    }

    $store->update(['stop_requested' => true]);

    Http::jsonResponse(['status' => 'ok', 'message' => 'Останавливаем анализ…']);
}