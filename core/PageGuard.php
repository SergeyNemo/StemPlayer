<?php

declare(strict_types=1);

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/RunState.php';

/**
 * Серверная взаимная блокировка страниц модулей.
 *
 * Кнопки на страницах тоже блокируются, но этого мало: пользователь может
 * открыть вторую вкладку, вставить URL или нажать «назад». Поэтому каждая
 * страница модуля проверяет демонов сама и, если занят соседний модуль,
 * отправляет посетителя на страницу, где сейчас реально идёт работа.
 */
final class PageGuard
{
    /**
     * Модули, у которых страница закрывается, пока работает сосед.
     */
    public const LOCKED_PAGES = [
        RunState::ANALYSIS => 'Страница «Обработка» закрыта: идёт генерация стемов.',
        RunState::STEMGEN  => 'Страница «Стемы» закрыта: идёт обработка треков.',
    ];

    /**
     * Если запущен соседний модуль — редирект на его страницу и выход.
     *
     * @param string      $module       self::ANALYSIS | self::STEMGEN — страница, которую открывают.
     * @param string|null $relativeBase Префикс относительного пути к корню приложения.
     */
    public static function enforce(string $module, ?string $relativeBase = '../'): void
    {
        $running = RunState::runningModule();

        if ($running === null || $running === $module) {
            return;
        }

        $target = ($relativeBase ?? '') . ($running === RunState::STEMGEN
            ? STEMPLAYER_STEMGEN_PAGE
            : STEMPLAYER_ANALYSIS_PAGE);

        if (!headers_sent()) {
            header('Location: ' . $target, true, 302);
            exit;
        }

        // Заголовки уже ушли (например, после предупреждения PHP) — мягкий ответ.
        http_response_code(409);
        echo self::LOCKED_PAGES[$module] ?? 'Страница закрыта: идёт работа в другом модуле.';
        exit;
    }

    /**
     * Главная страница-хаб: на время работы любого модуля она тоже закрыта —
     * отправляем посетителя туда, где идёт работа.
     *
     * @param string|null $relativeBase Префикс относительного пути к корню приложения.
     */
    public static function enforceHome(?string $relativeBase = ''): void
    {
        $running = RunState::runningModule();

        if ($running === null) {
            return;
        }

        $target = ($relativeBase ?? '') . ($running === RunState::STEMGEN
            ? STEMPLAYER_STEMGEN_PAGE
            : STEMPLAYER_ANALYSIS_PAGE);

        if (!headers_sent()) {
            header('Location: ' . $target, true, 302);
            exit;
        }

        echo 'Идёт ' . RunState::title($running) . ' — следите за прогрессом на странице модуля.';
        exit;
    }
}
