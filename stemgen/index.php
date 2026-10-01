<?php

declare(strict_types=1);

/**
 * Страница модуля «Стемы».
 *
 * Это PHP, а не статический HTML, потому что здесь нужна серверная взаимная
 * блокировка: пока идёт обработка треков, страница недоступна даже по прямой
 * ссылке (core/PageGuard.php).
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../core/RunState.php';
require_once __DIR__ . '/../core/PageGuard.php';

PageGuard::enforce(RunState::STEMGEN);
?>
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>StemPlayer — Стемы</title>
    <link rel="stylesheet" href="../analysis/assets/css/base.css?v=93">
    <link rel="stylesheet" href="../analysis/assets/css/components.css?v=93">
    <link rel="stylesheet" href="../analysis/assets/css/table.css?v=93">
    <link rel="stylesheet" href="assets/css/stemgen.css?v=93">
</head>
<body>
    <div class="app">
        <header class="header">
            <div class="brand">
                <span class="brand-dot"></span>
                <h1>StemPlayer</h1>
            </div>
            <nav class="nav">
                <a href="../index.php" id="nav-home">Главная</a>
                <a href="../analysis/index.php" id="nav-analysis">Обработка</a>
                <a href="index.php" class="active">Стемы</a>
            </nav>
        </header>

        <section class="lock-screen" id="lock-screen" hidden>
            <h2>Сначала обработайте треки</h2>
            <p>Разделение на стемы доступно после обработки. Загрузите треки в модуле «Обработка» — и они появятся здесь, где их можно будет прослушать, сравнить и скачать.</p>
            <a class="btn btn-primary" href="../analysis/index.php">Перейти к обработке</a>
        </section>

        <section class="tracks-view" id="tracks-view">
            <div class="toolbar">
                <div class="toolbar-left">
                    <button class="btn btn-primary" id="generate-btn" type="button">Сгенерировать стемы</button>
                    <button class="btn btn-ghost btn-stop" id="stop-btn" type="button" hidden>■ Стоп</button>
                </div>
                <div class="eq" id="stereo-eq" title="Каналы L/R — левый слева, правый справа: разбегается от центра">
                    <canvas></canvas>
                </div>
                <div class="toolbar-right">
                    <div class="overall-progress" id="overall-progress" hidden>
                        <div class="progress-track"><div class="progress-bar" id="progress-bar"></div></div>
                    </div>
                    <div class="log-line" id="log-line" hidden></div>
                </div>
            </div>

            <div class="table-wrap">
                <table class="tracks-table stem-table">
                    <tbody id="tracks-tbody"></tbody>
                </table>
            </div>
        </section>
    </div>

    <!-- Общее UI-ядро (бейдж статуса + блокировка ссылок в шапке):
         то же, что на странице «Обработка», - чтобы меню и статус
         вели себя одинаково на обоих модулях. -->
    <script src="../analysis/assets/js/core/ui.js?v=93"></script>
    <script src="../analysis/assets/js/core/eq.js?v=93"></script>
    <script src="assets/js/core/constants.js?v=93"></script>
    <script src="assets/js/core/dom.js?v=93"></script>
    <script src="assets/js/core/store.js?v=93"></script>
    <script src="assets/js/core/utils.js?v=93"></script>
    <script src="assets/js/services/api.js?v=93"></script>
    <script src="assets/js/services/notifier.js?v=93"></script>
    <script src="assets/js/services/download.js?v=93"></script>
    <script src="assets/js/engine/stem.js?v=93"></script>
    <script src="assets/js/engine/track.js?v=93"></script>
    <script src="assets/js/engine/player.js?v=93"></script>
    <script src="assets/js/engine/waveform.js?v=93"></script>
    <script src="assets/js/ui/spectrum.js?v=93"></script>
    <script src="assets/js/ui/level-meter.js?v=93"></script>
    <script src="assets/js/ui/channel.js?v=93"></script>
    <script src="assets/js/ui/table.js?v=93"></script>
    <script src="assets/js/services/generation.js?v=93"></script>
    <script src="assets/js/app.js?v=93"></script>
</body>
</html>
