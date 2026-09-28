<?php

declare(strict_types=1);

require_once __DIR__ . '/../../core/FileLog.php';

/**
 * Запуск анализа: общий цикл, лог, перекладывание в sorted/.
 * Работает в CLI-демоне (analysis/cli/analyze_cli.php); страница только
 * опрашивает состояние, поэтому отдельного канала событий здесь нет.
 */
final class AnalysisRunner
{
    /**
     * Общий цикл анализа каждого файла из inbox.
     *
     * @param ProgressStore $store Хранилище состояния демона.
     * @param list<string>  $files Абсолютные пути аудиофайлов.
     *
     * @return array{status: string, sorted: int, processed: int, total: int, folders: array<int, array<string, mixed>>, run_id: string}
     */
    public function run(ProgressStore $store, array $files): array
    {
        $runId = uniqid('run_', true);
        $store->reset($runId);

        $log = new FileLog(null, 'analysis');
        $log->write('info', "Прогон {$runId}: анализ запущен.");

        $tracks = new TracksIndex();

        // Обрабатываем только треки без успешного анализа (status !== 'done').
        // Файлы после анализа остаются в inbox (moveToSorted копирует), поэтому
        // уже обработанные пропускаем.
        $indexCache = $tracks->read();

        $files = array_values(array_filter(
            $files,
            static fn (string $file): bool => ($indexCache[strtolower(basename($file))] ?? ['status' => 'pending'])['status'] !== 'done'
        ));

        $store->update([
            'total'          => count($files),
            'stop_requested' => false,
        ]);
        $log->write('info', 'В очереди файлов: ' . count($files));

        $analysis    = new AnalysisService();
        $sorter      = new FileSorter();
        $sortedCount = 0;

        foreach ($files as $index => $file) {
            if ($this->stopRequested($store)) {
                break;
            }

            $name = basename($file);

            $store->update(['processed' => $index, 'current_file' => $name]);
            $store->markStage('start');

            // Что этот прогон уже создал по текущему треку — на случай стопа.
            // Учитываем только то, чего до прогона не было: чужую копию или
            // каталог с готовыми стемами откат трогать не должен.
            $created = [
                'copy'        => '',
                'copyExisted' => false,
                'metaDir'     => '',
                'metaDirNew'  => false,
                'metaFile'    => '',
                'metaFileNew' => false,
            ];

            $message = 'Анализ ' . $name . '...';
            $store->log('info', $message);
            $log->write('info', 'Начало: ' . $name);

            $stopCheck = function () use ($store): bool {
                $store->keepAlive();
                return $this->stopRequested($store);
            };

            // Этапы пайтона (load/bpm/key/meta) едут сюда из stdout скрипта:
            // пишем в progress.json только на смену этапа, без таймера.
            $onStage = function (string $stage) use ($store): void {
                $store->markStage($stage);
            };

            try {
                $result = $analysis->runAnalysis($file, $stopCheck, $onStage);
            } catch (Throwable $e) {
                if ($this->stopRequested($store)) {
                    $this->rollbackTrack($store, $tracks, $log, $name, $created);
                    break;
                }
                $msg = 'Ошибка PHP — ' . $e->getMessage();
                $tracks->save($name, ['status' => 'error', 'message' => $msg, 'updated_at' => date('c')]);
                $store->markError($name, $msg);
                $store->log('error', $name . ': ' . $msg);
                $log->write('error', $name . ': ' . $msg);
                continue;
            }

            if (($result['status'] ?? 'error') !== 'success') {
                if ($this->stopRequested($store)) {
                    $this->rollbackTrack($store, $tracks, $log, $name, $created);
                    break;
                }
                $msg = $result['message'] ?? 'Анализ не удался';
                $tracks->save($name, ['status' => 'error', 'message' => $msg, 'updated_at' => date('c')]);
                $store->markError($name, $msg);
                $store->log('error', $name . ': ' . $msg);
                $log->write('error', $name . ': ' . $msg);
                continue;
            }

            $bpm = (string) ($result['bpm'] ?? '');
            $key = (string) ($result['key'] ?? '');

            if ($bpm === '' || $key === '') {
                if ($this->stopRequested($store)) {
                    $this->rollbackTrack($store, $tracks, $log, $name, $created);
                    break;
                }
                $msg = 'Анализ выполнен, но BPM/Key отсутствуют';
                $tracks->save($name, ['status' => 'error', 'message' => $msg, 'updated_at' => date('c')]);
                $store->markError($name, $msg);
                $store->log('error', $name . ': Проведён анализ, но BPM/Key отсутствуют.');
                $log->write('error', $name . ': Проведён анализ, но BPM/Key отсутствуют.');
                continue;
            }

            $duration = isset($result['duration']) && $result['duration'] !== null
                ? (float) $result['duration']
                : null;

            $store->markStage('save');
            $expectedDest    = $sorter->sortedPathFor($file, $bpm, $key);
            $created['copyExisted'] = is_file($expectedDest);
            $destination     = $sorter->moveToSorted($file, $bpm, $key);

            if ($destination !== false) {
                $created['copy'] = $destination;
            }

            if ($destination === false) {
                if ($this->stopRequested($store)) {
                    $this->rollbackTrack($store, $tracks, $log, $name, $created);
                    break;
                }
                $msg = 'Не удалось скопировать в music/sorted/';
                $tracks->save($name, ['status' => 'error', 'message' => $msg, 'updated_at' => date('c')]);
                $store->markError($name, $msg);
                $store->log('error', $name . ': ' . $msg);
                $log->write('error', $name . ': ' . $msg);
                continue;
            }

            // Стоп мог прийти прямо во время перекладывания. Трек, который
            // не успел дописать результат, откатываем целиком — как и просил
            // пользователь: «всё, что связано со вторым треком».
            if ($this->stopRequested($store)) {
                $this->rollbackTrack($store, $tracks, $log, $name, $created);
                break;
            }

            $sortedCount++;
            $folder = basename(dirname($destination));
            $store->log('success', 'Успех: BPM ' . $bpm . ', Key ' . $key . ' -> ' . $folder);
            $log->write('success', 'Готово: ' . $name . ' (BPM ' . $bpm . ', Key ' . $key . ') -> ' . $folder);

            $metaMeta = $this->writeStemMeta($destination, $name, $bpm, $key, $duration, $result);
            $created['metaDir']     = $metaMeta['metaDir'];
            $created['metaDirNew']  = $metaMeta['metaDirNew'];
            $created['metaFile']    = $metaMeta['metaFile'];
            $created['metaFileNew'] = $metaMeta['metaFileNew'];

            if ($this->stopRequested($store)) {
                $this->rollbackTrack($store, $tracks, $log, $name, $created);
                break;
            }

            $tracks->save($name, [
                'status'     => 'done',
                'bpm'        => (int) $bpm,
                'key'        => $key,
                'duration'   => $duration,
                'updated_at' => date('c'),
            ]);

            // Сообщаем странице результат сразу, а не в финале прогона: иначе
            // уже обработанные треки до последнего опроса висели «В очереди…».
            $store->markStage('done');
            $store->markDone($name, [
                'bpm'      => (int) $bpm,
                'key'      => $key,
                'duration' => $duration,
            ]);
        }

        $folders = $sorter->listSortedFolders();

        $stopped        = $this->stopRequested($store);
        $processedFinal = $stopped ? (int) (($store->read()['processed'] ?? 0) ?: 0) : count($files);

        $store->update([
            'processed'    => $processedFinal,
            'current_file' => '',
            'status'       => $stopped ? 'stopped' : 'complete',
            'folders'      => $folders,
            'finished_at'  => date('c'),
        ]);

        $message = $stopped
            ? "Остановлено: обработано {$sortedCount} из " . count($files) . ' файлов.'
            : "Готово: обработано {$sortedCount} из " . count($files) . ' файлов.';
        $store->log('info', $message);

        if ($stopped) {
            $log->write('warning', 'Прогон остановлен пользователем.');
        }

        $log->write('info', "Итог прогона: {$message}");

        return [
            'status'    => $stopped ? 'stopped' : 'complete',
            'sorted'    => $sortedCount,
            'processed' => $processedFinal,
            'total'     => count($files),
            'folders'   => $folders,
            'run_id'    => $runId,
        ];
    }

    /**
     * Откат текущего трека после остановки.
     *
     * Убирает всё, что прогон успел сделать по этому треку: копию в
     * music/sorted/, каталог {id}/ с meta.json, запись в storage/tracks.json
     * и отметку в состоянии прогона. Ранее готовые треки не трогаем — их
     * делал другой прогон. Исходник в inbox/ остаётся: он не копия, а
     * исходный файл пользователя, и без него трек не переанализировать.
     *
     * @param array{copy?: string, copyExisted?: bool, metaDir?: string, metaDirNew?: bool, metaFile?: string, metaFileNew?: bool} $created
     */
    private function rollbackTrack(ProgressStore $store, TracksIndex $tracks, FileLog $log, string $name, array $created): void
    {
        $removed = [];

        $copy = (string) ($created['copy'] ?? '');

        if ($copy !== '' && empty($created['copyExisted']) && is_file($copy)) {
            @unlink($copy);
            $removed[] = 'копия в music/sorted/';
        }

        // meta.json и каталог {id}/ убираем только если их создал этот прогон.
        // Если каталог уже был (например, там уже лежат стемы), трогаем лишь
        // наш файл и оставляем каталог на месте.
        $metaFile = (string) ($created['metaFile'] ?? '');

        if ($metaFile !== '' && !empty($created['metaFileNew']) && is_file($metaFile)) {
            @unlink($metaFile);
            $removed[] = 'meta.json';
        }

        $metaDir = (string) ($created['metaDir'] ?? '');

        if ($metaDir !== '' && !empty($created['metaDirNew']) && is_dir($metaDir) && $this->isDirEmpty($metaDir)) {
            @rmdir($metaDir);
            $removed[] = 'каталог {id}/';
        }

        if ($tracks->forget($name)) {
            $removed[] = 'запись в storage/tracks.json';
        }

        $store->forget($name);

        $detail = $removed === [] ? 'нечего было убирать' : implode(', ', $removed);

        $store->log('warning', 'Остановка: откат трека ' . $name . ' (' . $detail . ').');
        $log->write('warning', "Остановка: откат трека {$name} — {$detail}. Исходник в inbox/ сохранён.");
    }

    /**
     * Каталог пуст? meta.json — единственное, что мы туда кладём, поэтому
     * непустой каталог (уже разложенные стемы) не трогаем.
     */
    private function isDirEmpty(string $dir): bool
    {
        $entries = @scandir($dir);

        if ($entries === false) {
            return false;
        }

        return array_values(array_diff($entries, ['.', '..'])) === [];
    }

    /**
     * Пишет (или обновляет) meta.json каталога стемов {id}/.
     *
     * ID совпадает со схемой модуля «Стемы» (StemRegistry::idFor), поэтому
     * результат анализа доступен модулю «Стемы» ещё до разделения на стемы.
     *
     * @param array<string, mixed> $result Результат анализа (json из analyzer.py).
     *
     * @return array{metaDir: string, metaDirNew: bool, metaFile: string, metaFileNew: bool}
     *         Что именно этот вызов создал — для отката при остановке.
     */
    private function writeStemMeta(string $destination, string $name, string $bpm, string $key, ?float $duration, array $result): array
    {
        $id     = substr(md5($name . $bpm . $key), 0, 8);
        $folder = dirname($destination);
        $metaDir = $folder . DIRECTORY_SEPARATOR . $id;
        $dirNew  = !is_dir($metaDir);

        if ($dirNew && !mkdir($metaDir, 0777, true) && !is_dir($metaDir)) {
            return ['metaDir' => '', 'metaDirNew' => false, 'metaFile' => '', 'metaFileNew' => false];
        }

        $file     = $metaDir . DIRECTORY_SEPARATOR . 'meta.json';
        $fileNew  = !is_file($file);
        $existing = [];

        if (!$fileNew) {
            $decoded = json_decode((string) file_get_contents($file), true);

            if (is_array($decoded)) {
                $existing = $decoded;
            }
        }
        $meta = array_merge($existing, [
            'original_name' => $name,
            'bpm'           => (int) $bpm,
            'key'           => $key,
            'updated_at'    => date('c'),
        ]);

        if ($duration !== null) {
            $meta['duration'] = $duration;
        }

        $tmp = $file . '.tmp';

        if (file_put_contents($tmp, json_encode($meta, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) !== false) {
            @rename($tmp, $file);

            return ['metaDir' => $metaDir, 'metaDirNew' => $dirNew, 'metaFile' => $file, 'metaFileNew' => $fileNew];
        }

        return ['metaDir' => $metaDir, 'metaDirNew' => $dirNew, 'metaFile' => '', 'metaFileNew' => false];
    }

    /**
     * Флаг остановки, выставляемый кнопкой «Стоп» (analysisApi.php?action=stop_analysis).
     */
    public function stopRequested(ProgressStore $store): bool
    {
        return $store->isStopRequested();
    }

    /**
     * @return list<string> Абсолютные пути к аудиофайлам из inbox.
     */
    public function collectInboxFiles(string $inboxDir): array
    {
        if (!is_dir($inboxDir)) {
            return [];
        }

        $files = [];

        foreach (scandir($inboxDir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }

            $full = $inboxDir . DIRECTORY_SEPARATOR . $entry;

            if (!is_file($full)) {
                continue;
            }

            $ext = strtolower(pathinfo($full, PATHINFO_EXTENSION));

            if (in_array($ext, STEMPLAYER_AUDIO_EXT, true)) {
                $files[] = $full;
            }
        }

        sort($files, SORT_STRING);

        return $files;
    }
}