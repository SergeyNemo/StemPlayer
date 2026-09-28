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
    const specCache = new Map(); // key -> canvas (готовая волна для отрисовки)
    const peaksCache = new Map(); // key -> Uint8Array (пики, переживают перезагрузку)

    // ---- Постоянный кеш пиков -------------------------------------------
    // Раньше кеш был только в памяти вкладки, поэтому каждый вход на страницу
    // заново скачивал и полностью декодировал каждый MP3 (OfflineAudioContext
    // + decodeAudioData) — на библиотеке это десятки мегабайт и заметная пауза.
    // Сохраняем сами пики: 800 байт на стем вместо canvas-битмапа, общий объём
    // копеечный. Ключ — URL + mtime (StemRegistry::stemRevs), поэтому после
    // перегенерации трека кеш протухает сам, ручная очистка не нужна.
    const STORE_KEY = 'stemgen.wave.v1';
    const COLS = 800;
    const HALF = 30; // половина высоты волны в px
    const MAX_ENTRIES = 600; // потолок записей (порядок 600 x ~1.1 КБ)

    let storeBroken = false; // localStorage недоступен (приватный режим и т.п.)

    function loadStore() {
        if (storeBroken) return {};
        try {
            const raw = window.localStorage.getItem(STORE_KEY);
            const obj = raw ? JSON.parse(raw) : {};
            return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
        } catch (e) {
            storeBroken = true;
            return {};
        }
    }

    function saveStore(data) {
        if (storeBroken) return;
        try {
            // Порядок ключей = порядок записи, поэтому лишнее отбрасываем
            // с начала (самые старые записи).
            const keys = Object.keys(data);
            if (keys.length > MAX_ENTRIES) {
                for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete data[k];
            }
            window.localStorage.setItem(STORE_KEY, JSON.stringify(data));
        } catch (e) {
            // Квота/приватный режим: работаем без кеша, лишь бы не падать.
            storeBroken = true;
        }
    }

    function packPeaks(peaks) {
        let bin = '';
        for (let i = 0; i < peaks.length; i += 4096) {
            bin += String.fromCharCode.apply(null, peaks.subarray(i, i + 4096));
        }
        return btoa(bin);
    }

    function unpackPeaks(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function storeKey(stem) {
        return stem.url + '|' + (stem.rev || 0);
    }

    function peaksFromStore(stem) {
        const data = loadStore();
        const rec = data[storeKey(stem)];
        if (!rec || typeof rec.p !== 'string') return null;
        try {
            return unpackPeaks(rec.p);
        } catch (e) {
            return null;
        }
    }

    function putPeaksToStore(stem, peaks) {
        const data = loadStore();
        data[storeKey(stem)] = { p: packPeaks(peaks) };
        saveStore(data);
    }

    function decodeForSpec(url) {
        return fetch(url)
            .then((res) => { if (!res.ok) throw new Error(`wave HTTP ${res.status}`); return res.arrayBuffer(); })
            .then((ab) => waveCtx.decodeAudioData(ab));
    }

    // Огибающая сигнала: 800 колонок по максимуму в каждой, нормированная к
    // 0..255 — этого достаточно и для рисунка, и для кеша в localStorage.
    function computePeaks(buffer) {
        const ch0 = buffer.getChannelData(0);
        const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
        const n = ch0.length;

        const step = Math.max(1, Math.floor(n / COLS));
        const raw = new Float32Array(COLS);

        let maxPeak = 1e-9;
        for (let c = 0; c < COLS; c++) {
            const start = c * step;
            const end = Math.min(n, start + step);
            let peak = 0;
            for (let i = start; i < end; i++) {
                const smp = Math.abs(ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i]);
                if (smp > peak) peak = smp;
            }
            raw[c] = peak;
            if (peak > maxPeak) maxPeak = peak;
        }

        const norm = maxPeak || 1;
        const out = new Uint8Array(COLS);
        for (let c = 0; c < COLS; c++) out[c] = Math.round((raw[c] / norm) * 255);

        return out;
    }

    // Отрисовка огибающей в offscreen-canvas: вверх - вниз, оранжевая.
    function peaksToCanvas(peaks) {
        const h = HALF * 2 + 2;
        const cvs = document.createElement('canvas');
        cvs.width = COLS; cvs.height = h;
        const g = cvs.getContext('2d');

        g.fillStyle = 'rgba(255,123,0,.16)';
        g.fillRect(0, 0, COLS, 1 + HALF * 2);

        g.fillStyle = '#ff7b00';
        for (let c = 0; c < COLS; c++) {
            const ph = Math.max(1, Math.round((peaks[c] / 255) * HALF));
            g.fillRect(c, HALF + 1 - ph, 1, ph);   // вверх
            g.fillRect(c, HALF + 1, 1, ph);        // вниз (зеркало)
        }

        return cvs;
    }

    G.ensureSpec = function ensureSpec(stem) {
        if (!stem.url) return;
        const key = storeKey(stem);
        if (specCache.has(key)) return;

        // 1) пики уже в памяти (эта же вкладка, повторный вызов);
        // 2) пики в localStorage (новая вкладка/перезагрузка) - без сети;
        // 3) иначе скачиваем и декодируем файл, пики кладём в кеш.
        const mem = peaksCache.get(key);
        if (mem) {
            specCache.set(key, peaksToCanvas(mem));
            return;
        }

        const stored = peaksFromStore(stem);
        if (stored) {
            peaksCache.set(key, stored);
            specCache.set(key, peaksToCanvas(stored));
            return;
        }

        specQueue = specQueue
            .then(() => decodeForSpec(stem.url))
            .then((buf) => {
                const peaks = computePeaks(buf);
                peaksCache.set(key, peaks);
                specCache.set(key, peaksToCanvas(peaks));
                putPeaksToStore(stem, peaks);
            })
            .catch(() => {});
    };

    // Волны рисуем фоном каналов. Во время проигрывания активного трека поверх
    // волны рисуем позицию: тонкий курсор + шлейф позади него (на всех стемах сразу).
    G.drawSpecs = function drawSpecs() {
        ui.forEach((r) => {
            const src = specCache.get(storeKey(r.stem));
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