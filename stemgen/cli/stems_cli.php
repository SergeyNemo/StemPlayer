<?php

declare(strict_types=1);

/**
 * Фоновый демон генерации стемов. Запускается отдельным CLI-процессом через
 * SpawnCli (start /B), поэтому переживает закрытие вкладки и переходы между
 * страницами модуля. Пишет состояние в storage/stemgen_progress.json.
 */

require_once __DIR__ . '/../../config.php';
require_once __DIR__ . '/../../core/ProgressStore.php';
require_once __DIR__ . '/../../core/FileLog.php';
require_once __DIR__ . '/../classes/StemGenInterface.php';
require_once __DIR__ . '/../classes/StemRegistry.php';
require_once __DIR__ . '/../classes/StemService.php';
require_once __DIR__ . '/../classes/StemRunner.php';

ignore_user_abort(true);

$store  = new ProgressStore(STEMGEN_PROGRESS_FILE);
$runner = new StemRunner();

try {
    $runner->run($store, (new StemRegistry())->listTracks());
} catch (Throwable $e) {
    (new FileLog(null, 'stemgen-cli'))->write('error', 'Фатальная ошибка CLI-демона: ' . $e->getMessage());
    $store->update(['status' => 'error', 'finished_at' => date('c')]);
    exit(1);
}