<?php

declare(strict_types=1);

/**
 * Хранение состояния прогресса анализа в storage/progress.json.
 * Используется для передачи статуса между длительным процессом
 * (analyze_inbox) и опросом (get_progress).
 */
final class ProgressStore
{
    private const MAX_LOG_ENTRIES = 500;

    private string $file;

    public function __construct(?string $file = null)
    {
        $this->file = $file ?? (__DIR__ . '/../storage/progress.json');
    }

    /**
     * @return array<string, mixed>
     */
    public function read(): array
    {
        if (!is_file($this->file)) {
            return $this->blank();
        }

        $raw = file_get_contents($this->file);

        if ($raw === false) {
            return $this->blank();
        }

        $data = json_decode($raw, true);

        return is_array($data) ? $data : $this->blank();
    }

    public function reset(string $runId): void
    {
        $blank = $this->blank();
        $blank['run_id']   = $runId;
        $blank['status']   = 'running';
        $blank['started_at'] = date('c');

        $this->write($blank);
    }

    /**
     * Применяет частичное обновление поверх текущего состояния.
     *
     * @param array<string, mixed> $patch
     */
    public function update(array $patch): void
    {
        $state = $this->read();
        unset($patch['log']);

        $this->write(array_merge($state, $patch));
    }

    public function log(string $type, string $message): void
    {
        $state = $this->read();

        $state['log'][] = [
            'time' => date('H:i:s'),
            'type' => $type,
            'message' => $message,
        ];

        if (count($state['log']) > self::MAX_LOG_ENTRIES) {
            $state['log'] = array_slice($state['log'], -self::MAX_LOG_ENTRIES);
        }

        $this->write($state);
    }

    /**
     * @param array<string, mixed> $state
     */
    private function write(array $state): void
    {
        $dir = dirname($this->file);

        if (!is_dir($dir) && !mkdir($dir, 0777, true) && !is_dir($dir)) {
            return;
        }

        // Пишем во временный файл и атомарно переименовываем: читатели никогда
        // не увидят "обрезанный" JSON в момент записи (гандикап flock на чтение).
        $tmp = $dir . '/progress.json.tmp';

        if (!@file_put_contents($tmp, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE))) {
            return;
        }

        @rename($tmp, $this->file);
    }

    /**
     * @return array<string, mixed>
     */
    private function blank(): array
    {
        return [
            'run_id'         => '',
            'status'         => 'idle',
            'total'          => 0,
            'processed'      => 0,
            'current_file'   => '',
            'stop_requested' => false,
            'live'           => null,
            'log'            => [],
            'folders'        => [],
            'started_at'     => null,
            'finished_at'    => null,
        ];
    }
}