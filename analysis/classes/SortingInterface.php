<?php

declare(strict_types=1);

/**
 * Контракт сортировщика файлов по BPM/Key.
 */
interface SortingInterface
{
    public function sanitizeFolderName(string $bpm, string $key): string;

    /**
     * @return string|false Путь к новому файлу или false при ошибке.
     */
    public function moveToSorted(string $sourcePath, string $bpm, string $key): string|false;
}