<?php

declare(strict_types=1);

/**
 * Контракт сервиса анализа аудио.
 */
interface AnalysisInterface
{
    /**
     * Запускает анализатор для одного файла.
     *
     * @param  string $filePath   Абсолютный путь к аудиофайлу.
     * @param  callable(float $fraction, string $phase): void|null $onProgress Опциональный колбэк живого прогресса.
     * @param  callable(): bool|null $stopCheck  Вернуть true — процесс анализа будет прерван.
     * @return array{
     *   status: 'success'|'error',
     *   bpm?: int,
     *   key?: string,
     *   message?: string,
     *   stderr?: string
     * }
     */
    public function runAnalysis(string $filePath, ?callable $onProgress = null, ?callable $stopCheck = null): array;
}