<?php

declare(strict_types=1);

/**
 * Фоновый демон обработки inbox. Запускается отдельным CLI-процессом через
 * SpawnCli (start /B), поэтому переживает закрытие вкладки и переходы между
 * страницами модуля. Пишет состояние в storage/progress.json (там же last_ping).
 */

require_once __DIR__ . '/../../config.php';
require_once __DIR__ . '/../../core/ProgressStore.php';
require_once __DIR__ . '/../../core/FileLog.php';
require_once __DIR__ . '/../classes/AnalysisInterface.php';
require_once __DIR__ . '/../classes/SortingInterface.php';
require_once __DIR__ . '/../classes/FileSorter.php';
require_once __DIR__ . '/../classes/TracksIndex.php';
require_once __DIR__ . '/../classes/AnalysisService.php';
require_once __DIR__ . '/../classes/AnalysisRunner.php';

ignore_user_abort(true);

$store  = new ProgressStore();
$runner = new AnalysisRunner();
$files  = $runner->collectInboxFiles(__DIR__ . '/../../music/inbox');

if ($files === []) {
    $store->update(['status' => 'complete', 'finished_at' => date('c')]);
    exit(0);
}

try {
    $runner->run($store, $files);
} catch (Throwable $e) {
    (new FileLog(null, 'analysis-cli'))->write('error', 'Фатальная ошибка CLI-демона: ' . $e->getMessage());
    $store->update(['status' => 'error', 'finished_at' => date('c')]);
    exit(1);
}