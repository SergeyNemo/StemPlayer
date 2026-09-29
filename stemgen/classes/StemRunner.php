<?php

declare(strict_types=1);

require_once __DIR__ . '/../../core/ProgressStore.php';
require_once __DIR__ . '/../../core/FileLog.php';
require_once __DIR__ . '/StemService.php';
require_once __DIR__ . '/StemRegistry.php';

/**
 * Цикл генерации стемов для всех треков music/sorted/.
 *
 * Треки обрабатываются строго последовательно (не перегружаем GPU).
 * Прогресс пишется в отдельный progress-файл модуля (STEMGEN_PROGRESS_FILE).
 */
final class StemRunner
{
    /**
     * Этапы разбиения одного трека — в том же порядке, что их шлёт
     * stem_splitter.py ({"stage": …}).
     *
     * Нужен для шкалы в карточке трека: без него Demucs молчит всё время
     * счёта, и строка «генерация…» висит с пустой полосой. Карта хранится
     * здесь (и дублируется в JS как STEM_STAGES), потому что PHP должен
     * знать и ключ этапа, и его номер - они пишутся в progress.json.
     *
     * @var array<string, string>
     */
    public const STAGES = ProgressStore::STEMGEN_STAGES;

    private StemService $service;
    private StemRegistry $registry;

    public function __construct(?StemService $service = null, ?StemRegistry $registry = null)
    {
        $this->service  = $service ?? new StemService();
        $this->registry = $registry ?? new StemRegistry();
    }

    /**
     * Прогон очереди. Демон пишет состояние в progress-файл модуля, страница
     * просто опрашивает его — отдельный канал событий не нужен.
     *
     * @param list<array<string, mixed>> $tracks
     *
     * @return array<string, mixed> Итоговое состояние прогона.
     */
    public function run(ProgressStore $store, array $tracks): array
    {
        if ($this->isAlreadyRunning($store)) {
            return ['status' => 'idle', 'message' => 'already_running'];
        }

        $runId = 'run_' . bin2hex(random_bytes(4));
        $log   = new FileLog(null, 'stemgen');
        $store->reset($runId);
        $store->update(['total' => count($tracks), 'stop_requested' => false]);
        $log->write('info', "Прогон {$runId}: генерация стемов, треков в очереди: " . count($tracks));

        if ($tracks === []) {
            $store->log('warning', 'В music/sorted/ нет треков для разделения.');
            $store->update(['status' => 'complete', 'finished_at' => date('c')]);
            return ['status' => 'idle', 'processed' => 0, 'total' => 0];
        }

        $processed = 0;
        $doneCount = 0;
        $errorCount = 0;
        $skipped = 0;
        // Каталоги стемов, задетые ЭТИМ прогоном. При остановке всё это
        // откатывается: прогон не завершился — значит, и его результат
        // не должен остаться. Треки «уже готовые» (done) в список не
        // попадают: они созданы прошлым прогоном и должны выжить.
        $runDirs = [];

        foreach ($tracks as $track) {
            if ($stopRequested = $this->stopRequested($store)) {
                break;
            }

            $name   = (string) ($track['name'] ?? '');
            $folder = (string) ($track['folder'] ?? '');
            $id     = (string) ($track['id'] ?? '');

            if (!empty($track['done'])) {
                $skipped++;
                $store->log('info', 'Стемы уже готовы: ' . $name);
                $log->write('info', 'Пропуск (уже готово): ' . $name);
                continue;
            }

            $runDirs[] = $this->registry->stemDir($folder, $id);

            $store->update(['current_file' => $name]);
            $store->log('info', 'Генерация: ' . $name);
            $log->write('info', 'старт: ' . $name);

            // Этап 'load' шлёт сам скрипт (первая строка stdout), но подстрахуемся:
            // если python не успел ничего вывести, карточка трека не останется
            // без подписи и шкалы.
            $store->markStage('load', self::STAGES);

            $onStage = function (string $stage) use ($store): void {
                $store->markStage($stage, self::STAGES);
            };

            $result = $this->service->generateStems(
                $this->registry->sourcePath($folder, $name),
                (int) ($track['bpm'] ?? 0),
                (string) ($track['key'] ?? ''),
                $id,
                // сюда outputDir = родитель каталога {id}/ - внутри BPM:_Key:,
                // а не сам {id}, иначе получится вложенность {id}/{id}/.
                dirname($this->registry->stemDir($folder, $id)),
                function () use ($store): bool {
                    $store->keepAlive();
                    return $this->stopRequested($store);
                },
                $onStage
            );

            // Этап 'done' ставим здесь, а не только в питоне: скрипт мог
            // упасть после последнего stage, а трек всё равно разделён и
            // проверен сервисом - пусть на шкале это видно.
            $store->markStage('done', self::STAGES);

            if (($result['status'] ?? '') === 'error') {
                $errorCount++;
                $message = (string) ($result['message'] ?? 'Ошибка Demucs');
                $store->log('error', $message);
                $log->write('error', $message . ' (' . $name . ')');
            } else {
                $doneCount++;
                $stems = $result['stems'] ?? STEMGEN_STEMS;
                // В ленту тулбара успех по треку не пишем: строка таблицы уже
                // показывает «Сгенерировано», а надпись «Стемы готовы: … (vocals,
                // bass, …)» была вторым источником правды об одном и том же
                // и висела в тулбаре после генерации всех стемов. В файловый
                // журнал запись остаётся — там она полезна.
                $log->write('success', 'Стемы готовы: ' . $name . ' (' . implode(', ', $stems) . ')');
            }

            $processed++;
            $store->update(['processed' => $processed]);
        }

        $stopped = $this->stopRequested($store);
        $status  = $stopped ? 'stopped' : 'complete';

        // Откат прерванного прогона: удаляем всё, что он создал за себя.
        // Раньше убирался только каталог трека, который в этот момент рвался;
        // успешно завершённые треки прогона оставались, хотя прогон целиком
        // не состоялся. Исходники в music/sorted/ не трогаем — они принадлежат
        // модулю «Обработка», а не стемам.
        if ($stopped) {
            $removed = $this->rollbackRunDirs($runDirs);

            $log->write('warning', "Прогон остановлен — откат: удалено каталогов стемов: {$removed}.");
            $store->log('warning', "Остановка: откат прогона, удалено каталогов стемов: {$removed}. Ранее готовые треки не тронуты.");
        }

        $store->update([
            'status'       => $status,
            'current_file' => '',
            'folders'      => $this->registryDoneTrees($tracks),
            'finished_at'  => date('c'),
        ]);

        if ($status === 'stopped') {
            $store->log('warning', 'Генерация остановлена пользователем.');
            $log->write('warning', 'Генерация остановлена пользователем.');
        } else {
            $log->write('info', 'Генерация завершена: обработано ' . $processed . ', готово ' . $doneCount . ', ошибок ' . $errorCount . ', пропущено ' . $skipped . '.');
        }

        $final = [
            'status'    => $status,
            'processed' => $processed,
            'total'     => count($tracks),
            'done'      => $doneCount,
            'errors'    => $errorCount,
            'skipped'   => $skipped,
            'run_id'    => $runId,
        ];

        return $final;
    }

    public function stopRequested(ProgressStore $store): bool
    {
        return $store->isStopRequested();
    }

    /**
     * Удаляет каталоги стемов, задетые прерванным прогоном.
     *
     * Отдельный метод (а не тело внутри run()) — чтобы его можно было
     * проверить тестом: сгенерировать стемы по-настоящему ради проверки
     * удаления не нужно, достаточно списка каталогов.
     *
     * @param list<string> $runDirs
     *
     * @return int Сколько каталогов удалено.
     */
    public function rollbackRunDirs(array $runDirs): int
    {
        $removed = 0;

        foreach (array_unique($runDirs) as $dir) {
            if (!is_dir((string) $dir)) {
                continue;
            }

            $this->removeDirRecursive((string) $dir);
            $removed++;
        }

        return $removed;
    }

    /**
     * Удаляет каталог целиком (stem-файлы + meta.json). Используется только для
     * каталогов {id}/, созданных/затронутых текущим прогоном.
     */
    private function removeDirRecursive(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }

        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }

            $full = $dir . DIRECTORY_SEPARATOR . $entry;

            if (is_dir($full)) {
                $this->removeDirRecursive($full);
            } else {
                @unlink($full);
            }
        }

        @rmdir($dir);
    }

    /**
     * Запуск-в-запуске: мёртвый «running» старше 30 минут считается неактивным
     * (процесс упал вместе с сервером).
     */
    private function isAlreadyRunning(ProgressStore $store): bool
    {
        $state = $store->read();

        if (($state['status'] ?? '') !== 'running') {
            return false;
        }

        // Живой процесс пишет last_ping каждой записью в progress-файл.
        // Прогресс этапный (ступени), между записями бывают длинные паузы
        // (демucs на трек) — 90 секунд без сердцебиения: процесс умер.
        $ping = $state['last_ping'] ?? null;

        if (is_numeric($ping)) {
            if ((time() - (int) $ping) <= 90) {
                return true;
            }

            $store->update(['status' => 'complete', 'finished_at' => date('c')]);
            (new FileLog(null, 'stemgen'))->write('warning', 'Обнаружен зависший процесс (старый last_ping) — статус сброшен в complete.');

            return false;
        }

        // Резерв для старых progress-файлов без last_ping: жив, если старт не старше 30 минут.
        $started = (string) ($state['started_at'] ?? '');

        if ($started === '') {
            return true;
        }

        $ts = strtotime($started);
        $fresh = $ts !== false && (time() - $ts) < 1800;

        if ($fresh) {
            return true;
        }

        $store->update(['status' => 'complete', 'finished_at' => date('c')]);

        return false;
    }

    /**
     * Дерево готовых папок для отображения после прогона.
     *
     * @return list<array{name: string, files: list<string>}>
     */
    private function registryDoneTrees(array $tracks): array
    {
        $map = [];

        foreach ($tracks as $track) {
            if (empty($track['done'])) {
                continue;
            }

            $folder  = (string) $track['folder'];
            $map[$folder][] = (string) $track['name'];
        }

        $out = [];

        foreach ($map as $folder => $files) {
            $out[] = ['name' => $folder, 'files' => $files];
        }

        return $out;
    }
}