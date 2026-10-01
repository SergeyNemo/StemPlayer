'use strict';
(function (G) {
    // Кэш DOM-узлов (один раз на старте).
    const els = {
        tbody: document.getElementById('tracks-tbody'),
        generateBtn: document.getElementById('generate-btn'),
        stopBtn: document.getElementById('stop-btn'),
        progressBar: document.getElementById('progress-bar'),
        overallProgress: document.getElementById('overall-progress'),
        logLine: document.getElementById('log-line'),
        lockScreen: document.getElementById('lock-screen'),
        tracksView: document.getElementById('tracks-view'),
        navHome: document.getElementById('nav-home'),
        navAnalysis: document.getElementById('nav-analysis'),
    };

    // Значок play: inline-SVG. Раньше был «треугольник из бордеров» на боксе
    // 0x0, который схлопывался — кнопка выглядела пустой. SVG рисуется всегда
    // и наследует цвет кнопки через currentColor.
    G.playIcon = function playIcon() {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'stem-glyph');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', 'M8 5.5v13l11-6.5z');
        svg.appendChild(path);
        return svg;
    };

    // Значок «сохранить стем» — папка, тот же приём, что у play-глифа:
    // inline-SVG с fill: currentColor, поэтому цвет берётся от кнопки, а
    // символ юникода не зависит от системного шрифта. Заливка (а не контур,
    // как у trashIcon в analysis) — потому что глиф мелкий (11 px по букве
    // подписи): тонкая обводка на таком размере распадается. Смысл кнопки
    // несёт подсказка, которая показывает итоговое имя файла.
    G.saveIcon = function saveIcon() {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'save-glyph');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        const path = document.createElementNS(NS, 'path');
        // Силуэт папки: клеймо на клавише TAB, «куда складывают».
        path.setAttribute('d', 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z');
        svg.appendChild(path);
        return svg;
    };

    G.els = els;
})(window.StemGen);