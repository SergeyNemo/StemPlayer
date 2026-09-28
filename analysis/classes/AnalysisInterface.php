<?php

declare(strict_types=1);

/**
 * Контракт сервиса анализа аудио.
 */
interface AnalysisInterface
{
    /**
     * Запуск анализа одного файла.
     *
     * @param  string $filePath   Абсолютный путь к аудиофайлу.
     * @param  callable(): bool|null $stopCheck  Вернуть true — прервать анализ.
     * @param  callable(string): void|null $onStage Получить идентификатор текущего
     *         этапа ("load", "bpm", "key", "meta") в момент его наступления.
     * @return array{
     *   status: 'success'|'error',
     *   bpm?: int,
     *   key?: string,
     *   message?: string,
     *   stderr?: string
     * }
     */
    public function runAnalysis(string $filePath, ?callable $stopCheck = null, ?callable $onStage = null): array;
}