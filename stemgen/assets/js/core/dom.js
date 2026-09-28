'use strict';
(function (G) {
    // Кэш DOM-узлов (один раз на старте).
    const els = {
        tbody: document.getElementById('tracks-tbody'),
        statusBadge: document.getElementById('status-badge'),
        generateBtn: document.getElementById('generate-btn'),
        stopBtn: document.getElementById('stop-btn'),
        trackTotal: document.getElementById('track-total-text'),
        progressBar: document.getElementById('progress-bar'),
        overallProgress: document.getElementById('overall-progress'),
        banner: document.getElementById('banner'),
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

    G.els = els;
})(window.StemGen);