<?php

declare(strict_types=1);

/**
 * Запуск анализа: общий цикл, лог, перекладывание в sorted/.
 * Используется и в SSE-стриме, и в фолбэк-режиме (analyze_inbox).
 */
final class AnalysisRunner
{
    /**
     * Общий цикл анализа каждого файла из inbox.
     *
     * @param ProgressStore     $store     Хранилище прогресса.
     * @param list<string>      $files     Абсолютные пути аудиофайлов.
     * @param bool              $streaming True — дублируем события в SSE-поток.
     *
     * @return array{status: string, sorted: int, processed: int, total: int, folders: array<int, array<string, mixed>>, run_id: string}
     */
    public function run(ProgressStore $store, array $files, bool $streaming = false): array
    {
        $runId = uniqid('run_', true);
        $store->reset($runId);

        $store->update([
            'total'          => count($files),
            'stop_requested' => false,
        ]);

        $analysis    = new AnalysisService();
        $sorter      = new FileSorter();
        $tracks      = new TracksIndex();
        $sortedCount = 0;

        foreach ($files as $index => $file) {
            if ($this->stopRequested($store)) {
                break;
            }

            $name = basename($file);

            $store->update(['processed' => $index, 'current_file' => $name]);

            if ($streaming) {
                Http::sseEmit('progress', ['processed' => $index, 'total' => count($files), 'current_file' => $name]);
                Http::sseEmit('track_start', ['index' => $index, 'name' => $name, 'total' => count($files)]);
            }

            $message = 'Анализ ' . $name . '...';
            $store->log('info', $message);
            if ($streaming) {
                Http::sseEmit('log', ['time' => date('H:i:s'), 'type' => 'info', 'message' => $message]);
            }

            // Прогресс пишем и в progress.json (throttle ~0.4с) — фронт опрашивает его в любом режиме.
            $lastLiveAt = 0.0;
            $progressCb = static function (float $fraction, string $phase) use ($store, $name, $streaming, &$lastLiveAt): void {
                if ($streaming) {
                    Http::sseEmit('track_progress', ['name' => $name, 'progress' => $fraction, 'phase' => $phase]);
                }

                if (microtime(true) - $lastLiveAt >= 0.4) {
                    $lastLiveAt = microtime(true);
                    $store->update(['live' => ['name' => $name, 'progress' => $fraction, 'phase' => $phase]]);
                }
            };

            $stopCheck = fn (): bool => $this->stopRequested($store);

            try {
                $result = $analysis->runAnalysis($file, $progressCb, $stopCheck);
            } catch (Throwable $e) {
                if ($this->stopRequested($store)) {
                    break;
                }
                $tracks->save($name, ['status' => 'error', 'message' => 'Ошибка PHP — ' . $e->getMessage(), 'updated_at' => date('c')]);
                $store->log('error', $name . ': Ошибка PHP — ' . $e->getMessage());
                if ($streaming) {
                    Http::sseEmit('track_error', ['name' => $name, 'message' => 'Ошибка PHP — ' . $e->getMessage()]);
                }
                continue;
            }

            if (($result['status'] ?? 'error') !== 'success') {
                if ($this->stopRequested($store)) {
                    break;
                }
                $msg = $result['message'] ?? 'Анализ не удался';
                $tracks->save($name, ['status' => 'error', 'message' => $msg, 'updated_at' => date('c')]);
                $store->log('error', $name . ': ' . $msg);
                if ($streaming) {
                    Http::sseEmit('track_error', ['name' => $name, 'message' => $msg]);
                }
                continue;
            }

            $bpm = (string) ($result['bpm'] ?? '');
            $key = (string) ($result['key'] ?? '');

            if ($bpm === '' || $key === '') {
                if ($this->stopRequested($store)) {
                    break;
                }
                $tracks->save($name, ['status' => 'error', 'message' => 'Анализ выполнен, но BPM/Key отсутствуют', 'updated_at' => date('c')]);
                $store->log('error', $name . ': Проведён анализ, но BPM/Key отсутствуют.');
                if ($streaming) {
                    Http::sseEmit('track_error', ['name' => $name, 'message' => 'Анализ выполнен, но BPM/Key отсутствуют']);
                }
                continue;
            }

            $duration = isset($result['duration']) && $result['duration'] !== null
                ? (float) $result['duration']
                : null;

            $destination = $sorter->moveToSorted($file, $bpm, $key);

            if ($destination === false) {
                if ($this->stopRequested($store)) {
                    break;
                }
                $tracks->save($name, ['status' => 'error', 'message' => 'Не удалось скопировать в music/sorted/', 'updated_at' => date('c')]);
                $store->log('error', $name . ': Не удалось скопировать в music/sorted/.');
                if ($streaming) {
                    Http::sseEmit('track_error', ['name' => $name, 'message' => 'Не удалось скопировать в music/sorted/']);
                }
                continue;
            }

            $sortedCount++;
            $folder = basename(dirname($destination));
            $store->log('success', 'Успех: BPM ' . $bpm . ', Key ' . $key . ' -> ' . $folder);

            $tracks->save($name, [
                'status'     => 'done',
                'bpm'        => (int) $bpm,
                'key'        => $key,
                'duration'   => $duration,
                'updated_at' => date('c'),
            ]);

            if ($streaming) {
                Http::sseEmit('log', ['time' => date('H:i:s'), 'type' => 'success', 'message' => 'Успех: BPM ' . $bpm . ', Key ' . $key . ' -> ' . $folder]);
                Http::sseEmit('track_done', ['name' => $name, 'bpm' => $bpm, 'key' => $key, 'folder' => $folder, 'duration' => $duration]);
            }
        }

        $folders = $sorter->listSortedFolders();

        $stopped        = $this->stopRequested($store);
        $processedFinal = $stopped ? (int) (($store->read()['processed'] ?? 0) ?: 0) : count($files);

        $store->update([
            'processed'    => $processedFinal,
            'current_file' => '',
            'status'       => $stopped ? 'stopped' : 'complete',
            'folders'      => $folders,
            'live'         => null,
            'finished_at'  => date('c'),
        ]);

        $message = $stopped
            ? "Остановлено: обработано {$sortedCount} из " . count($files) . ' файлов.'
            : "Готово: обработано {$sortedCount} из " . count($files) . ' файлов.';
        $store->log('info', $message);
        if ($streaming) {
            Http::sseEmit('log', ['time' => date('H:i:s'), 'type' => 'info', 'message' => $message]);
        }

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
     * Флаг остановки, выставляемый кнопкой «Стоп» (api.php?action=stop_analysis).
     */
    public function stopRequested(ProgressStore $store): bool
    {
        return ($store->read()['stop_requested'] ?? false) === true;
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

    public function isRunningNotStale(string $startedAt): bool
    {
        if ($startedAt === '') {
            return true;
        }

        try {
            $started = new DateTimeImmutable($startedAt);
        } catch (Throwable) {
            return true;
        }

        return $started->diff(new DateTimeImmutable())->i < 30;
    }
}