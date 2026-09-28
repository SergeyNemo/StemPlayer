<?php

declare(strict_types=1);

/**
 * API модуля «Стемы» (stemgen).
 *
 * Доступные действия:
 *   stemgenApi.php?action=get_tracks       — таблица треков music/sorted/ + статус стемов (+ analysis_running)
 *   stemgenApi.php?action=start_generation — запуск фоновой генерации стемов (CLI-демон, независим от страницы)
 *   stemgenApi.php?action=get_progress     — состояние демона из storage/stemgen_progress.json (+ analysis_running)
 *   stemgenApi.php?action=stop_generation  — запрос остановки очереди
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
require_once __DIR__ . '/classes/StemGenInterface.php';
require_once __DIR__ . '/classes/StemRegistry.php';
require_once __DIR__ . '/classes/StemService.php';
require_once __DIR__ . '/classes/StemRegistry.php';
require_once __DIR__ . '/classes/StemService.php';

// Long-running запросы не должны обрываться клиентом или сервером.
ignore_user_abort(true);
set_time_limit(0);
if (STEMPLAYER_MAX_EXEC_TIME > 0) {
    set_time_limit(STEMPLAYER_MAX_EXEC_TIME);
}

$action = (string) ($_GET['action'] ?? '');
$store  = new ProgressStore(STEMGEN_PROGRESS_FILE);
$flog   = new FileLog(null, 'stemgen-api');

match ($action) {
    'get_tracks'       => handleGetTracks(),
    'start_generation' => handleStartGeneration($store, $flog),
    'get_progress'     => handleGetProgress($store),
    'stop_generation'  => handleStop($store, $flog),
    default            => Http::jsonResponse(['status' => 'error', 'message' => 'Неизвестное действие: ' . $action]),
};

function handleGetTracks(): void
{
    $registry = new StemRegistry();

    Http::jsonResponse([
        'status'           => 'ok',
        'rows'             => $registry->listTracks(),
        'analysis_running' => RunState::otherModuleRunning(RunState::STEMGEN),
    ]);
}

/**
 * Запуск фоновой генерации стемов через CLI-демон (не зависит от страницы).
 */
function handleStartGeneration(ProgressStore $store, FileLog $flog): void
{
    $state = $store->read();

    if (($state['status'] ?? '') === 'running' && RunState::isFresh($state)) {
        Http::jsonResponse(['status' => 'already_running', 'message' => 'Генерация стемов уже выполняется.', 'started' => false]);
    }

    // Взаимная блокировка: пока идёт обработка треков, генерацию не запускаем.
    if (RunState::otherModuleRunning(RunState::STEMGEN)) {
        Http::jsonResponse(['status' => 'blocked', 'message' => 'Сейчас идёт обработка треков — запустите генерацию после её завершения.', 'started' => false]);
    }

    $registry = new StemRegistry();
    $tracks = $registry->listTracks();

    if ($tracks === []) {
        Http::jsonResponse(['status' => 'idle', 'message' => 'Нет обработанных треков — генерацию запускать нечего.', 'started' => false]);
    }

    $lockPath = __DIR__ . '/../storage/stemgen_start.lock';
    $lock = @fopen($lockPath, 'c');

    if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
        Http::jsonResponse(['status' => 'already_running', 'message' => 'Генерация уже запускается.', 'started' => false]);
    }

    try {
        $spawnLog = __DIR__ . '/../logs/spawn-stemgen.log';
        $beforeRunId = (string) ($store->read()['run_id'] ?? '');
        $beforePing = (int) ($store->read()['last_ping'] ?? 0);

        $spawn = SpawnCli::spawn(__DIR__ . '/cli/stems_cli.php', $spawnLog);

        if (!$spawn['ok']) {
            $flog->write('error', 'Не удалось запустить демон: ' . ($spawn['error'] ?? 'неизвестная причина'));
            Http::jsonResponse(['status' => 'error', 'message' => $spawn['error'] ?? 'Не удалось запустить фоновый процесс.', 'started' => false]);
        }

        // Демон обязан подать признаки жизни в progress-файле (новый run_id).
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
            $flog->write('error', 'Демон генерации не подал признаков жизни за 4 с.' . ($tail !== '' ? ' Вывод: ' . $tail : ' Лог демона пуст.'));
            Http::jsonResponse([
                'status'  => 'error',
                'started' => false,
                'message' => 'Фоновый процесс не запустился. ' . ($tail !== '' ? 'Вывод: ' . $tail : 'Смотри logs/spawn-stemgen.log.'),
            ]);
        }
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }

    $flog->write('info', 'Запущена фоновая генерация стемов (CLI-демон).');
    Http::jsonResponse(['status' => 'started', 'message' => 'Генерация запущена.', 'started' => true]);
}

function handleGetProgress(ProgressStore $store): void
{
    $data = $store->read();
    $data['analysis_running'] = RunState::otherModuleRunning(RunState::STEMGEN);

    Http::jsonResponse($data);
}

function handleStop(ProgressStore $store, FileLog $flog): void
{
    $flog->write('info', 'Запрошена остановка генерации.');
    $store->requestStop();
    Http::jsonResponse(['status' => 'ok', 'stop_requested' => true]);
}