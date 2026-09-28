<?php

declare(strict_types=1);

/**
 * Контракт разделения одного трека на стемы.
 */
interface StemGenInterface
{
    /**
     * @param callable(): bool|null $stopCheck «прервать?» - true = ждать остановки.
     * @param callable(string): void|null $onStage Сообщить этап разбиения
     *        (load/demucs/collect/save/done) - им заполняется шкала в карточке.
     *
     * @return array<string, mixed> {status:'done', stems:[...]} | {status:'error', message: string}
     */
    public function generateStems(
        string $filePath,
        int $bpm,
        string $key,
        string $id,
        string $outputDir,
        ?callable $stopCheck = null,
        ?callable $onStage = null
    ): array;

}