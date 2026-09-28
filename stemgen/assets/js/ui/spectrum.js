'use strict';
(function (G) {
    const { player } = G;

    // Переиспользуемый буфер данных (без аллокаций в каждом кадре).
    let specData = null;

    // Рисуем только в ОДНО место — в бокс названия играющего трека. Панель
    // микшера над таблицей убрана: спектр живёт фоном под названием, поэтому
    // canvas-ов ровно столько, сколько строк, а активен из них один.
    let target = null;
    let targetCtx = null;

    // Вызывается из syncPlayingUI при смене играющего трека.
    G.setTitleEq = function setTitleEq(canvas) {
        if (canvas === target) return;
        // Прежний надо очистить, иначе застывший спектр останется в чужой строке.
        if (target && targetCtx) {
            targetCtx.setTransform(1, 0, 0, 1, 0, 0);
            targetCtx.clearRect(0, 0, target.width, target.height);
        }
        target = canvas || null;
        targetCtx = target ? target.getContext('2d') : null;
        if (!target) specData = null; // смена трека = смена fftSize
    };

    G.drawTitleEq = function drawTitleEq() {
        const cv = target;
        const c = targetCtx;
        if (!cv || !c) return;

        const w = cv.clientWidth, h = cv.clientHeight;
        if (!w || !h) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pw = Math.max(1, Math.round(w * dpr));
        const ph = Math.max(1, Math.round(h * dpr));
        if (cv.width !== pw) cv.width = pw;
        if (cv.height !== ph) cv.height = ph;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, w, h);

        if (!player.analyser) return;

        if (!specData || specData.length !== player.analyser.frequencyBinCount) {
            specData = new Uint8Array(player.analyser.frequencyBinCount);
        }
        player.analyser.getByteFrequencyData(specData);

        // Логарифмическая шкала 40 Гц – 16 кГц, как у octave-метки: низкие
        // частоты иначе сплющиваются в пару столбиков слева.
        const fMin = 40, fMax = 16000;
        const lMin = Math.log(fMin), lRange = Math.log(fMax) - lMin;

        const bars = Math.max(24, Math.floor(w / 5));
        const gap = 1;
        const bw = Math.max(1, (w - gap * (bars - 1)) / bars);
        const base = h - 1;

        for (let i = 0; i < bars; i++) {
            const f = fMin * Math.pow(fMax / fMin, i / (bars - 1));
            const idx = Math.min(specData.length - 1,
                Math.round((Math.log(f) - lMin) / lRange * (specData.length - 1)));
            const v = specData[idx] / 255;
            const bh = Math.max(1, v * (h - 3));
            const x = i * (bw + gap);
            // Прозрачность намеренно низкая: это фон под названием, текст
            // должен читаться, а столбики — только намекать, что играет.
            const alpha = 0.10 + v * 0.24;
            c.fillStyle = `rgba(255, 148, 56, ${alpha.toFixed(3)})`;
            c.fillRect(x, base - bh, bw, bh);
        }
    };
})(window.StemGen);
