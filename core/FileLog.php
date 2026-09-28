<?php

declare(strict_types=1);

/**
 * Файловый журнал ключевых событий: logs/stemplayer.log (отдельная папка
 * на уровне корня проекта — storage/ очищается при каждом тесте).
 * Пишет одной строкой с временем и модулем; при достижении ~2 МБ укатывает
 * текущий лог в *.old и продолжает писать новый файл. Никогда не бросает
 * исключений — это вспомогательное средство отладки.
 */
final class FileLog
{
    private string $file;
    private ?string $module;

    public function __construct(?string $file = null, ?string $module = null)
    {
        $this->file   = $file ?? dirname(__DIR__) . '/logs/stemplayer.log';
        $this->module = $module;
    }

    public function write(string $level, string $message, ?string $module = null): void
    {
        $dir = dirname($this->file);

        if (!is_dir($dir) && !mkdir($dir, 0777, true) && !is_dir($dir)) {
            return;
        }

        if (is_file($this->file) && filesize($this->file) > 2 * 1024 * 1024) {
            @rename($this->file, $this->file . '.old');
        }

        $who  = $module ?? $this->module ?? 'core';
        $line = sprintf(
            '[%s] [%s/%s] %s%s',
            date('Y-m-d H:i:s'),
            $who,
            strtoupper($level),
            $message,
            PHP_EOL
        );

        @file_put_contents($this->file, $line, FILE_APPEND | LOCK_EX);
    }
}