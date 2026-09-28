<?php

declare(strict_types=1);

require_once __DIR__ . '/ProgressStore.php';

/**
 * Помощник «живости» фонового процесса: процесс считается работающим,
 * пока в его progress-файле есть свежий last_ping (или свежий started_at
 * для старых файлов). Используется для взаимной блокировки модулей.
 */
final class RunState
{
    /** Модуль «Обработка» (analysis). */
    public const ANALYSIS = 'analysis';

    /** Модуль «Стемы» (stemgen). */
    public const STEMGEN = 'stemgen';

    public static function isFresh(array $state): bool
    {
        $ping = $state['last_ping'] ?? null;

        if (is_numeric($ping)) {
            // Работа идёт этапами (python-скрипт пишет дискретные шаги), поэтому
            // между соседними записями может проходить заметное время поиска/загрузки.
            return (time() - (int) $ping) <= 90;
        }

        $started = (string) ($state['started_at'] ?? '');

        if ($started === '') {
            return false;
        }

        $ts = strtotime($started);

        return $ts !== false && (time() - $ts) < 1800;
    }

    /**
     * Файл состояния модуля.
     */
    public static function progressFile(string $module): string
    {
        return $module === self::STEMGEN ? STEMGEN_PROGRESS_FILE : ANALYSIS_PROGRESS_FILE;
    }

    /**
     * Жив ли фоновый демон указанного модуля.
     *
     * @param string $module self::ANALYSIS | self::STEMGEN
     */
    public static function isModuleRunning(string $module): bool
    {
        try {
            $state = (new ProgressStore(self::progressFile($module)))->read();

            return ($state['status'] ?? '') === 'running' && self::isFresh($state);
        } catch (Throwable) {
            return false;
        }
    }

    /**
     * Жив ли демон СОСЕДНЕГО модуля — взаимная блокировка.
     *
     * @param string $module self::ANALYSIS | self::STEMGEN
     */
    public static function otherModuleRunning(string $module): bool
    {
        return self::isModuleRunning(self::opposite($module));
    }

    /**
     * Какой модуль сейчас реально работает (null — оба свободны).
     */
    public static function runningModule(): ?string
    {
        if (self::isModuleRunning(self::STEMGEN)) {
            return self::STEMGEN;
        }

        if (self::isModuleRunning(self::ANALYSIS)) {
            return self::ANALYSIS;
        }

        return null;
    }

    /**
     * Человеческое имя модуля для сообщений.
     */
    public static function title(string $module): string
    {
        return $module === self::STEMGEN ? 'генерация стемов' : 'обработка треков';
    }

    private static function opposite(string $module): string
    {
        return $module === self::STEMGEN ? self::ANALYSIS : self::STEMGEN;
    }
}
