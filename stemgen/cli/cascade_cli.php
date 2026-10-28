<?php

declare(strict_types=1);

/**
 * Фоновый демон каскадного разделения стема (Other → guitar/piano).
 *
 * Запускается отдельным CLI-процессом через SpawnCli (как и stems_cli.php),
 * поэтому переживает закрытие вкладки. Аргументов не получает: что делить,
 * узнаёт из файла-дескриптора storage/cascade_request.json, который пишет API
 * и который демон читает и сразу удаляет.
 *
 * Прогресс пишется в общий STEMGEN_PROGRESS_FILE с полем mode = "cascade",
 * поэтому RunState/PageGuard и взаимная блокировка модулей работают как есть.
 */

require_once __DIR__ . '/../../config.php';
require_once __DIR__ . '/../../core/ProgressStore.php';
require_once __DIR__ . '/../../core/FileLog.php';
require_once __DIR__ . '/../classes/StemGenInterface.php';
require_once __DIR__ . '/../classes/StemRegistry.php';
require_once __DIR__ . '/../classes/StemService.php';

ignore_user_abort(true);

$store = new ProgressStore(STEMGEN_PROGRESS_FILE);
$log   = new FileLog(null, 'stemgen-cascade');

$request = readCascadeRequest();

if ($request === null) {
    $log->write('error', 'Запрос каскада не найден или повреждён: ' . STEMGEN_CASCADE_REQUEST_FILE);
    exit(1);
}

$id   = (string) $request['id'];
$stem = (string) ($request['stem'] ?? STEMGEN_CASCADE_SOURCE_STEM);

$runId = 'run_' . bin2hex(random_bytes(4));
$store->reset($runId);
$store->update([
    'mode'         => 'cascade',
    'total'        => 1,
    'cascade_id'   => $id,
    'current_file' => $id,
]);

$store->markStage('load', ProgressStore::STEMGEN_CASCADE_STAGES);
$log->write('info', 'Каскад: старт ' . $id . ' (стем ' . $stem . ')');

try {
    $result = (new StemService())->splitInstrument(
        $id,
        $stem,
        function () use ($store): bool {
            $store->keepAlive();
            return $store->isStopRequested();
        },
        function (string $stage) use ($store): void {
            $store->markStage($stage, ProgressStore::STEMGEN_CASCADE_STAGES);
        }
    );
} catch (Throwable $e) {
    cleanupCascadeTemp($id);
    $log->write('error', 'Фатальная ошибка каскада: ' . $e->getMessage());
    $store->update(['status' => 'error', 'finished_at' => date('c')]);
    exit(1);
}

$isStopped = $store->isStopRequested() || (($result['status'] ?? '') === 'error' && str_contains((string) ($result['message'] ?? ''), 'прерван'));

if ($isStopped) {
    cleanupCascadeTemp($id);
    $store->update(['status' => 'stopped', 'finished_at' => date('c')]);
    $store->log('warning', 'Каскадное разделение остановлено пользователем.');
    $log->write('warning', 'Каскад остановлен пользователем (' . $id . ')');
    exit(0);
}

if (($result['status'] ?? '') === 'error') {
    cleanupCascadeTemp($id);
    $message = (string) ($result['message'] ?? 'Ошибка каскадного разделения');
    $store->log('error', $message);
    $store->update(['status' => 'error', 'processed' => 1, 'finished_at' => date('c')]);
    $log->write('error', $message . ' (' . $id . ')');
    exit(1);
}

// Этап 'done' ставим только при успешном завершении
$store->markStage('done', ProgressStore::STEMGEN_CASCADE_STAGES);

$stems = $result['stems'] ?? STEMGEN_CASCADE_STEMS;

$store->update([
    'status'        => 'complete',
    'processed'     => 1,
    'cascade_stems' => $stems,
    'finished_at'   => date('c'),
]);

$log->write('success', 'Каскад готов: ' . $id . ' (' . implode(', ', $stems) . ')');

/**
 * Очищает временный подкаталог _temp_cascade внутри папки трека при сбое/остановке.
 */
function cleanupCascadeTemp(string $id): void
{
    $track = (new StemRegistry())->findById($id);
    if ($track === null) {
        return;
    }

    $tempDir = $track['dir'] . DIRECTORY_SEPARATOR . '_temp_cascade';
    if (is_dir($tempDir)) {
        removeCascadeDirRecursive($tempDir);
    }
}

function removeCascadeDirRecursive(string $dir): void
{
    foreach (scandir($dir) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }
        $full = $dir . DIRECTORY_SEPARATOR . $entry;
        if (is_dir($full)) {
            removeCascadeDirRecursive($full);
        } else {
            @unlink($full);
        }
    }
    @rmdir($dir);
}

/**
 * Читает и сразу удаляет файл-дескриптор запроса каскада.
 *
 * @return array{id: string, stem?: string}|null
 */
function readCascadeRequest(): ?array
{
    if (!is_file(STEMGEN_CASCADE_REQUEST_FILE)) {
        return null;
    }

    $raw = (string) @file_get_contents(STEMGEN_CASCADE_REQUEST_FILE);
    @unlink(STEMGEN_CASCADE_REQUEST_FILE);

    $data = json_decode($raw, true);

    if (!is_array($data) || !preg_match('/^[0-9a-f]{8}$/', (string) ($data['id'] ?? ''))) {
        return null;
    }

    return $data;
}
