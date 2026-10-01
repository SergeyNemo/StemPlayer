<?php

declare(strict_types=1);

/**
 * Точка входа StemPlayer: страница со списком модулей.
 *
 * Каждый модуль — самостоятельная папка со своим API (`{module}Api.php`)
 * и страницей (`index.php`). Здесь только карточки-ссылки.
 *
 * Пока работает любой из модулей, хаб закрыт: он перенаправляет на страницу
 * запущенного модуля (core/PageGuard.php).
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/core/RunState.php';
require_once __DIR__ . '/core/PageGuard.php';

PageGuard::enforceHome();

/** @var list<array{slug: string, title: string, desc: string}> */
$modules = [
    [
        'slug'  => 'analysis',
        'title' => 'Обработка',
        'desc'  => 'Анализ BPM/Key, очередь, сортировка по папкам, общий плеер.',
    ],
    [
        'slug'  => 'stemgen',
        'title' => 'Стемы',
        'desc'  => 'Разделение треков на вокал/бас/ударные/остальное (Demucs + CUDA).',
    ],
];
?>
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StemPlayer — модули</title>
<link rel="stylesheet" href="analysis/assets/css/base.css?v=93">
<style>
    body { padding: 2rem; }
    .modules { display: grid; gap: 1rem; max-width: 720px; margin-top: 1.5rem; }
    .module {
        display: block;
        padding: 1.25rem;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--panel);
        text-decoration: none;
        color: inherit;
        transition: border-color .15s ease;
    }
    .module:hover { border-color: var(--accent); }
    .module h2 { margin: 0 0 .35rem; font-size: 1.15rem; color: var(--accent); }
    .module p { margin: 0; font-size: .9rem; }
    .module .status {
        display: inline-block;
        margin-top: .6rem;
        font-size: .75rem;
        padding: .15rem .6rem;
        border-radius: 999px;
        background: rgba(0,0,0,.35);
        color: #7fe08a;
    }
</style>
</head>
<body>
    <h1>StemPlayer</h1>
    <p>Модульная система: обработка музыки + разделение на стемы.</p>

    <nav class="modules">
        <?php foreach ($modules as $module): ?>
            <a class="module" href="<?= $module['slug'] ?>/index.php">
                <h2><?= htmlspecialchars($module['title']) ?> →</h2>
                <p><?= htmlspecialchars($module['desc']) ?></p>
                <span class="status">открыть</span>
            </a>
        <?php endforeach; ?>
    </nav>
</body>
</html>
