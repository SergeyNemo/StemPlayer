'use strict';
(function (G) {
    const { ui, player } = G;

    // Волновая форма стема — фон карточки. Оффлайн-контекст для декодирования
    // без вывода звука; считаем по одному стему за раз (декодирование тяжёлое).
    const waveCtx = (() => {
        const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        return AC ? new AC(2, 44100, 44100) : null;
    })();

    let specQueue = Promise.resolve();
    const specCache = new Map(); // url -> canvas (готовый спектрограммный слой)

    function decodeForSpec(url) {
        return fetch(url)
            .then((res) => { if (!res.ok) throw new Error(`wave HTTP ${res.status}`); return res.arrayBuffer(); })
            .then((ab) => waveCtx.decodeAudioData(ab));
    }

    // Зеркальная волна: центр — ноль, пики — вверх и вниз от него.
    function computeWaveCanvas(buffer) {
        const ch0 = buffer.getChannelData(0);
        const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
        const n = ch0.length;

        const COLS = 800;
        const half = 30; // высота пика в px от центра
        const h = half * 2 + 2;
        const step = Math.max(1, Math.floor(n / COLS));

        const cvs = document.createElement('canvas');
        cvs.width = COLS; cvs.height = h;
        const g = cvs.getContext('2d');

        g.fillStyle = 'rgba(255,123,0,.16)';
        g.fillRect(0, 0, COLS, 1 + half * 2);

        let maxPeak = 1e-9;
        const peaks = new Float32Array(COLS);
        for (let c = 0; c < COLS; c++) {
            const start = c * step;
            const end = Math.min(n, start + step);
            let peak = 0;
            for (let i = start; i < end; i++) {
                const smp = Math.abs(ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i]);
                if (smp > peak) peak = smp;
            }
            peaks[c] = peak;
            if (peak > maxPeak) maxPeak = peak;
        }

        const norm = maxPeak || 1;
        g.fillStyle = '#ff7b00';
        for (let c = 0; c < COLS; c++) {
            const ph = Math.max(1, Math.round((peaks[c] / norm) * half));
            g.fillRect(c, half + 1 - ph, 1, ph);          // вверх
            g.fillRect(c, half + 1, 1, ph);               // вниз (зеркало)
        }

        return cvs;
    }

    G.ensureSpec = function ensureSpec(stem) {
        if (!stem.url || specCache.has(stem.url)) return;
        specQueue = specQueue
            .then(() => decodeForSpec(stem.url))
            .then((buf) => { specCache.set(stem.url, computeWaveCanvas(buf)); })
            .catch(() => {});
    };

    // Волны рисуем фоном каналов. Во время проигрывания активного трека поверх
    // волны рисуем позицию: тонкий курсор + шлейф позади него (на всех стемах сразу).
    G.drawSpecs = function drawSpecs() {
        ui.forEach((r) => {
            const src = specCache.get(r.stem.url);
            const specEl = r.ch.specEl;
            if (!src || !specEl) return;
            const item = r.ch.panel;
            const w = item.clientWidth, h = item.clientHeight;
            if (!w || !h) return;
            const c = specEl.getContext('2d');
            if (specEl.width !== w || specEl.height !== h) {
                specEl.width = w;
                specEl.height = h;
                // Смена размера стирает bitmap canvas. Сбрасываем флаг, иначе
                // «нарисованная один раз» волна после ресайза не вернётся.
                r.ch.specDrawn = false;
            }
            // Волна на всю ширину, по высоте — с сохранением пропорций, по центру.
            const fh = Math.min(h, Math.round(src.height * (w / src.width)));
            const fy = Math.round((h - fh) / 2);

            const playing = player.activeTrack && player.activeTrack.id === r.track.id;

            if (!playing) {
                // Не играем: волну рисуем один раз, без курсора.
                if (!r.ch.specDrawn) {
                    c.drawImage(src, 0, 0, src.width, src.height, 0, fy, w, fh);
                    r.ch.specDrawn = true;
                }
                return;
            }

            // Играем: перерисовываем каждый кадр, добавляем курсор и шлейф.
            r.ch.specDrawn = true;
            c.clearRect(0, 0, w, h);
            c.drawImage(src, 0, 0, src.width, src.height, 0, fy, w, fh);

            const dur = r.stem.duration;
            if (!dur) return;
            const t = r.stem.currentTime;
            const p = Math.max(0, Math.min(1, t / dur));
            const cx = p * w; // дробная координата (без рывков)

            // Шлейф позади курсора: яркое свечение у полосы, плавно гаснет к началу.
            const tail = Math.min(cx, 90);
            if (tail > 1) {
                const g = c.createLinearGradient(cx - tail, 0, cx, 0);
                g.addColorStop(0, 'rgba(255, 123, 0, 0)');
                g.addColorStop(1, 'rgba(255, 148, 56, .45)');
                c.fillStyle = g;
                c.fillRect(cx - tail, 0, tail, h);
            }

            // Тонкая полоса позиции.
            const xi = Math.floor(cx);
            const frac = cx - xi;
            c.fillStyle = 'rgba(255, 148, 56, .95)';
            c.fillRect(xi, 0, 2, h);
            if (frac > 0.02) {
                c.fillStyle = 'rgba(255, 148, 56, ' + (0.95 * frac).toFixed(3) + ')';
                c.fillRect(xi + 2, 0, 1, h);
            }
        });
    };
})(window.StemGen);