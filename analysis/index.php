<?php

declare(strict_types=1);

/**
 * Страница модуля «Обработка».
 *
 * Это PHP, а не статический HTML, потому что здесь нужна серверная взаимная
 * блокировка: пока идёт генерация стемов, страница недоступна даже по
 * прямой ссылке (core/PageGuard.php).
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../core/RunState.php';
require_once __DIR__ . '/../core/PageGuard.php';

PageGuard::enforce(RunState::ANALYSIS);
?>
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>StemPlayer — Обработка</title>
    <link rel="stylesheet" href="assets/css/base.css?v=16">
    <link rel="stylesheet" href="assets/css/components.css?v=16">
    <link rel="stylesheet" href="assets/css/table.css?v=16">
</head>
<body>
    <div class="app">
        <header class="header">
            <div class="brand">
                <span class="brand-dot"></span>
                <h1>StemPlayer <small>Обработка</small></h1>
            </div>
            <nav class="nav">
                <a href="../index.php" id="nav-home">Главная</a>
                <a href="index.php" class="active">Обработка</a>
                <a href="../stemgen/index.php" id="nav-stemgen">Стемы</a>
            </nav>
            <div class="status-badge" id="status-badge" data-state="idle">idle</div>
        </header>

        <!-- Состояние 1: inbox пуст -> загрузка -->
        <section class="upload-zone" id="upload-zone" hidden>
            <div class="dropzone" id="dropzone" tabindex="0">
                <div class="dz-icon">&#9834;</div>
                <p class="dz-title">Папка inbox пуста</p>
                <p class="dz-hint">Перетащите сюда аудиофайлы или нажмите, чтобы выбрать</p>
                <button class="btn btn-ghost" type="button" id="pick-btn">Выбрать файлы</button>
                <input type="file" id="file-input" accept=".mp3,.wav,.flac,.ogg,.aac,.m4a,.wma,.aiff,.aif,audio/*" multiple hidden>
            </div>
            <div class="upload-progress" id="upload-progress" hidden>
                <span id="upload-status">Загрузка…</span>
                <div class="progress-track"><div class="progress-fill" id="upload-fill"></div></div>
            </div>
        </section>

        <!-- Состояние 2: inbox не пуст -> таблица -->
        <section class="tracks-view" id="tracks-view" hidden>
            <div class="toolbar">
                <div class="toolbar-left">
                    <button class="btn btn-primary" id="process-btn" type="button">Обработать</button>
                    <button class="btn btn-ghost" id="add-btn" type="button">+ Добавить треки</button>
                    <button class="btn btn-ghost btn-stop" id="stop-btn" type="button" hidden>■ Стоп</button>
                    <span class="toolbar-meta">
                        <span id="track-total-text">Треков нет</span>
                    </span>
                </div>
                <div class="toolbar-right">
                    <div class="overall-progress" id="overall-progress" hidden>
                        <div class="progress-track"><div class="progress-bar" id="progress-bar"></div></div>
                    </div>
                    <div class="log-line" id="log-line" hidden></div>
                </div>
            </div>

            <div class="banner" id="banner" hidden>
                <span class="banner-text" id="banner-text"></span>
            </div>

            <div class="table-wrap">
                <table class="tracks-table">
                    <thead>
                        <tr>
                            <th class="col-num" data-sort="num" title="Сортировать по №">№ <span class="sort-ind"></span></th>
                            <th class="col-track" data-sort="track" title="Перемешать треки">Трек и исполнитель <span class="sort-ind"></span></th>
                            <th class="col-center" data-sort="bpm" title="Сортировать по BPM">BPM <span class="sort-ind"></span></th>
                            <th class="col-center" data-sort="key" title="Сортировать по тональности">Тональность <span class="sort-ind"></span></th>
                            <th class="col-center" data-sort="duration" title="Сортировать по длительности">Длительность <span class="sort-ind"></span></th>
                        </tr>
                    </thead>
                    <tbody id="tracks-tbody"></tbody>
                </table>
            </div>
        </section>
    </div>

    <!-- Общее UI-ядро: бейдж статуса + блокировка ссылок в шапке.
         Классический скрипт, а не модуль: нужен и «Обработке» (ES-модули),
         и «Стемам» (window.StemGen), и выполняется раньше них. -->
    <script src="assets/js/core/ui.js?v=16"></script>
    <script type="module" src="assets/js/main.js?v=16"></script>
</body>
</html>
