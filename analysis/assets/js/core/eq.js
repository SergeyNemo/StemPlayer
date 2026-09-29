/**
 * Стерео-эквалайзер в полосе тулбара. Раскладка зеркальная: басы у краёв,
 * верхи диапазона — к центру (слева низкие, справа тоже низкие, к центру
 * высокие с обеих сторон). Столбики стоят каждый на своём месте, без
 * наездов друг на друга, и ходят только вверх-вниз по уровню звука.
 *
 * Два источника:
 *   - «Обработка» играет через HTMLAudioElement -> честное разделение L/R
 *     (ChannelSplitter + два AnalyserNode), звук при этом остаётся стерео
 *     через ChannelMerger.
 *   - «Стемы» живут целиком внутри WebAudio (AudioBufferSourceNode) — там
 *     свой контекст с готовым анализатором мастера; мы зеркалим его спектр
 *     на обе стороны.
 *
 * Классический скрипт (не ES-модуль): подключается до скриптов обеих
 * страниц, как core/ui.js, и отдаёт себя в window.StereoEq.
 */
'use strict';
(function (G) {
    const AC = window.AudioContext || window.webkitAudioContext;

    const cfg = {
        bars: 28,          // максимум столбиков на сторону (по ширине полосы)
        baseGap: 4,        // отступ от центра
        barRatio: 0.58,    // доля шага, которую занимает столбик
        insetX: 7,         // отступ крайних столбиков от краёв рамки
        insetY: 6,         // отступ сверху и снизу
        attack: 0.5,       // скорость подъёма столбика
        decay: 0.9,        // затухание после пика
        minH: 3,           // минимальная высота (px)
    };

    let root = null;
    let canvas = null;
    let g = null;
    let ro = null;
    let raf = 0;
    let n = cfg.bars;

    let audioCtx = null;      // собственный контекст «Обработки»
    let srcNode = null;       // MediaElementSource (один на привязанный элемент)
    let anL = null, anR = null;
    let spl = null, mrg = null;
    let boundEl = null;       // привязанный аудиоэлемент
    let analyserNode = null;  // AnalyserNode «Стемов» (одиночный)
    let media = false;        // true — режим L/R анализаторов
    let smooth = [];
    let mediaBuf = [];

    function size() {
        const dpr = window.devicePixelRatio || 1;
        const w = root.clientWidth || 0;
        const h = root.clientHeight || 0;
        canvas.width = Math.max(2, Math.round(w * dpr));
        canvas.height = Math.max(2, Math.round(h * dpr));
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const half = Math.max(30, w / 2 - cfg.insetX);
        // Шаг столбика держим примерно одинаковым на любой ширине: на широком
        // экране полосы плотнее, на телефоне — реже, но читаемо. Делим на
        // (шаг + доля столбика), иначе крайний уезжает за отступ insetX.
        const target = half > 300 ? 26 : 15;
        n = Math.max(5, Math.min(cfg.bars, Math.round((half - cfg.baseGap) / (target + cfg.barRatio / 2))));
        smooth = new Array(n * 2).fill(0);
    }

    function init() {
        root = document.getElementById('stereo-eq');
        if (!root) return false;
        canvas = root.querySelector('canvas');
        if (!canvas) return false;
        g = canvas.getContext('2d');
        size();
        ro = new ResizeObserver(size);
        ro.observe(root);
        return true;
    }

    function ensure() {
        return root || init();
    }

    // ---------- WebAudio «Обработки» ----------

    function ensureMediaCtx(el) {
        if (!AC) return false;
        try {
            if (!audioCtx) audioCtx = new AC();
            if (!srcNode || boundEl !== el) {
                if (srcNode && boundEl) { try { srcNode.disconnect(); } catch (e) {} }
                srcNode = audioCtx.createMediaElementSource(el);
                boundEl = el;

                spl = audioCtx.createChannelSplitter(2);
                anL = audioCtx.createAnalyser();
                anR = audioCtx.createAnalyser();
                anL.fftSize = 128;
                anR.fftSize = 128;
                anL.smoothingTimeConstant = 0;
                anR.smoothingTimeConstant = 0;

                mrg = audioCtx.createChannelMerger(2);

                srcNode.connect(spl);
                spl.connect(anL, 0);
                spl.connect(anR, 1);
                // Стерео не ломается: L и R снова сводятся в пару.
                anL.connect(mrg, 0, 0);
                anR.connect(mrg, 0, 1);
                mrg.connect(audioCtx.destination);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    // ---------- Запуск / останов ----------

    function cancel() {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        if (root) root.classList.remove('is-active');
    }

    function pumpAll() {
        drawPump();
        raf = requestAnimationFrame(pumpAll);
    }

    function start() {
        cancel();
        root.classList.add('is-active');
        raf = requestAnimationFrame(pumpAll);
    }

    // ---------- Отрисовка ----------

    function drawPump() {
        const w = root.clientWidth;
        const h = root.clientHeight;
        const cx = w / 2;
        // Отступы от краёв рамки: без них крайние столбики (низкие частоты)
        // вылезали за пределы eq, а на невысокой полосе — и вверх.
        const half = Math.max(30, cx - cfg.insetX);
        // Шаг подбираем так, чтобы последний столбик встал ровно на отступ:
        // baseGap + n*pitch + bw/2 === half (столбик центрируется на слоте).
        const pitch = (half - cfg.baseGap) / (n + cfg.barRatio / 2);
        const bw = Math.max(3, pitch * cfg.barRatio);
        const base = h - cfg.insetY;
        const maxH = Math.max(6, base - cfg.insetY);

        const bin = (media && anL) ? anL.frequencyBinCount
                    : (analyserNode ? analyserNode.frequencyBinCount : 0);
        if (bin > 0) {
            const node = media ? anL : analyserNode;
            if (mediaBuf.length !== bin) mediaBuf = new Uint8Array(bin);
            node.getByteFrequencyData(mediaBuf);
            readHalf(mediaBuf, bin, 0);
            if (media) {
                anR.getByteFrequencyData(mediaBuf);
                readHalf(mediaBuf, bin, 1);
            } else {
                readHalf(mediaBuf, bin, 1); // стемы: зеркалим левую половину в правую
            }
        }

        g.clearRect(0, 0, w, h);

        // i = 0 — столбик у центра (верхи диапазона), i = n-1 — у края (басы).
        // Позиция столбика постоянна: движется только высота, вверх-вниз.
        for (let i = 0; i < n; i++) {
            const slot = (i + 1) * pitch;

            const vL = smooth[i];
            const bhl = Math.max(cfg.minH, vL * maxH);
            bar(cx - cfg.baseGap - slot - bw / 2, base - bhl, bw, bhl);

            const vR = smooth[n + i];
            const bhr = Math.max(cfg.minH, vR * maxH);
            bar(cx + cfg.baseGap + slot - bw / 2, base - bhr, bw, bhr);
        }
    }

    function bar(x, y, w, h) {
        // Низ столбика темнее (выгорание к верху, где яркий кончик с акцентом).
        const grd = g.createLinearGradient(0, y, 0, y + h);
        grd.addColorStop(0, 'rgba(255,145,30,.85)');
        grd.addColorStop(.55, 'rgba(255,123,0,.6)');
        grd.addColorStop(1, 'rgba(60,28,0,.12)');
        g.fillStyle = grd;
        g.beginPath();
        if (typeof g.roundRect === 'function') g.roundRect(x, y, w, h, Math.min(3, w / 2));
        else g.rect(x, y, w, h);
        g.fill();
    }

    // Лог-разбиение спектра на n полос + сглаживание движения.
    // i = 0 — полоса у центра, там верхи диапазона; i = n-1 — у края, басы.
    function readHalf(buf, bin, side) {
        const base = side === 0 ? 0 : n;
        for (let i = 0; i < n; i++) {
            const p1 = 1 - i / n;
            const p0 = 1 - (i + 1) / n;
            let b0 = Math.floor(Math.pow(p0, 2.2) * (bin - 2)) + 1;
            let b1 = Math.floor(Math.pow(p1, 2.2) * (bin - 2)) + 1;
            if (b1 <= b0) b1 = b0 + 1;
            let v = 0;
            for (let j = b0; j < b1; j++) if (buf[j] > v) v = buf[j];
            const level = Math.pow(v / 255, 1.35);
            const idx = base + i;
            if (level > smooth[idx]) smooth[idx] = smooth[idx] + (level - smooth[idx]) * cfg.attack;
            else smooth[idx] = Math.max(0, smooth[idx] * cfg.decay);
        }
    }

    // ---------- Публичное API ----------

    G.StereoEq = {
        // «Обработка»: честное стерео по HTMLAudioElement.
        attachMedia(el) {
            if (!ensure()) return;
            if (!el) return;
            if (!ensureMediaCtx(el)) return;
            media = true;
            analyserNode = null;
            if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
            start();
        },

        // «Стемы»: готовый анализатор мастера, зеркалим на обе стороны.
        attachAnalyser(node) {
            if (!ensure()) return;
            if (!node) return;
            media = false;
            analyserNode = node;
            if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
            start();
        },

        detach() {
            cancel();
            media = false;
            analyserNode = null;
            // Собственный контекст «Обработки» засыпаем: новый attachMedia разбудит.
            if (audioCtx && audioCtx.state !== 'suspended') {
                audioCtx.suspend().catch(() => {});
            }
        },
    };
})(window);