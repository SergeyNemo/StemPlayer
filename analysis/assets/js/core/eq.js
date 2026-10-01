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

    // Фоновое «дыхание» для состояния «никто не играет». Без него тулбар с
    // выключенным EQ выглядит пустым — пустая рамка на месте полосы.
    //
    // Это НЕ бегущая волна и не «бас, всегда стоящий высоко». Все столбики
    // начинают внизу, и цикл состоит из вдоха и выдоха:
    //   вдох   — поднимается бас, потом его сосед, и так до самого верха у
    //            центра; последний едва-едва, «совсем чуточку»;
    //   пауза  — все стоят на своих местах: лестница от полного баса к
    //            еле заметному верху;
    //   выдох  — верхний у центра опускается, за ним соседний, и так обратно
    //            до баса; в ноль уходят все, дальше цикл начинается заново.
    //
    // Ключевое отличие от волны: все столбики ДОХОДЯТ до своих высот к одному
    // моменту (`riseEnd`) и УХОДЯТ в ноль к концу цикла. Поэтому бас растёт
    // всё время, пока поднимаются остальные, а потом так же опускается —
    // ничего не «уезжает» вместе с бегущим гребнем.
    //
    // Время задано в долях периода, а не в секундах, и отставание задано
    // относительным сдвигом соседа, а не шагом по столбикам: тогда на узком
    // экране (где столбиков меньше) раскладка по времени остаётся той же.
    //
    // Скорость подъёма тоже убывает к центру. Это отдельный параметр `slow`,
    // и он НЕ равен `spread`: столбик не только стартует позже соседа, но и
    // финиширует заметно позже, поэтому его окно длиннее и он растёт медленнее.
    // Проверка: окно баса = riseTo - slow - riseFrom (0.20 периода), окно
    // верхнего у центра = riseTo - riseFrom - spread (0.46) — в 2.3 раза
    // длиннее, значит скорость падает в 2.3 раза. Если бы slow == spread, все
    // окна были бы равны и столбики росли линейно, синхронно, «шторкой».
    const idle = {
        fps: 20,           // «дыхание» медленное, 20 кадров/с хватает: фоновая
                            // анимация не должна стоить как живой спектр
        period: 7,         // секунд на полный цикл (вдох + пауза + выдох)

        // Вдох: бас стартует первым, верх у центра — последним.
        riseFrom: 0.04,    // когда стартует бас
        riseTo: 0.58,      // когда закончил последний столбик
        spread: 0.08,      // соседний начинает позже на столько долей периода
        slow: 0.34,        // и заканчивает позже на столько. slow > spread —
                            // именно это и замедляет рост к центру
        hold: 0.06,        // пауза: все стоят на своих местах

        // Выдох — зеркально: верх у центра уходит первым, бас последним,
        // и опускается бас дольше всех (fallSlow > fallSpread).
        fallSpread: 0.06,
        fallSlow: 0.18,

        ampBass: 1,        // бас встаёт во всю полосу
        ampTop: 0.12,      // верхний у центра — «совсем чуточку»
        curve: 1.4,        // насколько резко ступени убывают от баса к центру
        minH: 1.5,         // в покое столбик-сливка у нижней границы
    };


    let root = null;
    let canvas = null;
    let g = null;
    let ro = null;
    let raf = 0;
    let n = cfg.bars;
    let active = false;     // true — рисуем живой спектр
    let idleT = 0;          // секунды фоновой волны
    let idleLast = 0;       // метка последнего отрисованного кадра фона

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
        // Смена размера обнуляет canvas, поэтому профиль надо нарисовать заново:
        // иначе после ресайза/поворота телефона фон был бы пустым до следующего
        // кадра, а в статичном режиме (без анимации) — навсегда.
        if (active) drawPump();
        else if (root && root.classList.contains('is-idle')) drawIdle();
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

    // Кто-то выключил анимацию в системе: рисуем ту же огибающую, но один
    // раз и без гребня. Полоса остаётся на месте, но не мигает.
    const calm = window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    const reduced = () => !!(calm && calm.matches);

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

    function stopLoop() {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }

    // Живой спектр: снимает analysers, рисует звук.
    function pumpAll() {
        drawPump();
        raf = requestAnimationFrame(pumpAll);
    }

    // Фоновая волна: analysers не читаем, рисуем только свою огибающую.
    function pumpIdle(ts) {
        raf = requestAnimationFrame(pumpIdle);
        if (!idleLast) idleLast = ts;
        if (ts - idleLast < 1000 / idle.fps) return;
        idleT += (ts - idleLast) / 1000;
        idleLast = ts;
        drawIdle();
    }

    function start() {
        stopLoop();
        active = true;
        root.classList.remove('is-idle');
        root.classList.add('is-active');
        raf = requestAnimationFrame(pumpAll);
    }

    // Ничего не играет — тулбар не должен выглядеть пустым.
    function startIdle() {
        if (!ensure()) return;
        stopLoop();
        active = false;
        idleT = 0;
        idleLast = 0;
        root.classList.remove('is-active');
        root.classList.add('is-idle');
        drawIdle();
        // Выключенная анимация: один статичный кадр, цикл не крутим.
        if (!reduced()) raf = requestAnimationFrame(pumpIdle);
    }

    // ---------- Отрисовка ----------

    // Общая геометрия полосы: и живой спектр, и фоновая волна обязаны
    // считать столбики одинаково, иначе фон «прыгает» в рабочий вид.
    function geom() {
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
        return { w, h, cx, pitch, bw, base, maxH };
    }

    function drawPump() {
        const G0 = geom();
        const w = G0.w;
        const h = G0.h;
        const cx = G0.cx;
        const pitch = G0.pitch;
        const bw = G0.bw;
        const base = G0.base;
        const maxH = G0.maxH;

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

    // Фоновое «дыхание»: analysers не читаем вообще, рисуем свою огибающую.
    // i = 0 — у центра (верхи диапазона), i = n-1 — у края (басы), как и
    // в живом спектре, поэтому фон и звук занимают одни и те же столбики.
    function drawIdle() {
        const G0 = geom();
        const w = G0.w;
        const h = G0.h;
        const cx = G0.cx;
        const pitch = G0.pitch;
        const bw = G0.bw;
        const base = G0.base;
        const maxH = G0.maxH;

        g.clearRect(0, 0, w, h);

        // Фаза цикла в долях периода. Цикл — вдох и выдох, а НЕ бегущая волна:
        //   вдох   — бас, потом соседний, и так до верхнего у центра; каждый
        //             стартует позже предыдущего И финиширует заметно позже,
        //             поэтому к центру столбики растут всё медленнее;
        //   пауза  — все стоят на своих местах: полная лестница от баса к центру;
        //   выдох  — верхний у центра, потом соседний, и так обратно до баса;
        //             в ноль уходят все, дальше цикл начинается заново.
        //
        // Выключенная анимация → замираем на пике вдоха (u = riseTo): там
        // полоса читается как готовый эквалайзер, а не как обрезок чего-то.
        const u = reduced() ? idle.riseTo : (idleT % idle.period) / idle.period;
        // С конца вдоха до начала выдоха все стоят на своих местах.
        const fallFrom = idle.riseTo + idle.hold;

        for (let i = 0; i < n; i++) {
            const slot = (i + 1) * pitch;

            // t = 0 у центра (верхи) и 1 у края (басы): «басовость» столбика.
            const t = n > 1 ? i / (n - 1) : 1;

            // Куда столбик встаёт: бас во всю полосу, верх у центра — совсем
            // чуть-чуть, иначе «дыхание» превращается в кашу из равных пиков.
            const target = idle.ampTop
                + (idle.ampBass - idle.ampTop) * Math.pow(t, idle.curve);

            // Окно вдоха. Бас стартует первым и финиширует первым, верх у
            // центра — последним. Длина окна = riseTo - slow*t - riseFrom
            // - spread*(1-t), то есть она РАСТЁТ к центру: бас летит быстро,
            // последние столбики еле заметно всползают. Отсюда и затухание
            // скорости к последнему — при slow == spread окна были бы равны.
            const rs = idle.riseFrom + (1 - t) * idle.spread;
            const re = idle.riseTo - t * idle.slow;
            // Окно выдоха — зеркальное: верх уходит первым, бас последним,
            // и опускается бас дольше всех (fallSlow > fallSpread).
            const fs = fallFrom + t * idle.fallSpread;
            const fe = 1 - (1 - t) * idle.fallSlow;

            let v;
            if (u < rs) {
                v = 0;                                        // ещё не начал
            } else if (u < re) {
                v = target * smooth01((u - rs) / (re - rs));
            } else if (u < fs) {
                v = target;                                   // стоит на месте
            } else {
                // За fe эта формула сама даёт 0: smooth01 зажат единицей.
                v = target * (1 - smooth01((u - fs) / (fe - fs)));
            }

            const bh = Math.max(idle.minH, v * maxH);

            bar(cx - cfg.baseGap - slot - bw / 2, base - bh, bw, bh);
            bar(cx + cfg.baseGap + slot - bw / 2, base - bh, bw, bh);
        }
    }

    // Плавный разгон/торможение 0..1. Линейный ход давал бы заметный излом
    // в момент старта и остановки столбика, а «дыхание» с изломами не дышит.
    function smooth01(x) {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        return x * x * (3 - 2 * x);
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

        // Звук закончился: не оставляем полосу пустой, а уходим в фоновую
        // волну — тулбар остаётся живым, просто еле заметным.
        detach() {
            media = false;
            analyserNode = null;
            // Собственный контекст «Обработки» засыпаем: новый attachMedia разбудит.
            if (audioCtx && audioCtx.state !== 'suspended') {
                audioCtx.suspend().catch(() => {});
            }
            startIdle();
        },

        // Фоновая волна без звука (старт страницы, если ничего не играет).
        idle() {
            if (!ensure()) return;
            if (active) return;   // живой спектр важнее фона
            if (root.classList.contains('is-idle')) return;
            startIdle();
        },
    };

    // Старт фона сам, как только появился тулбар: EQ инициализировался лениво,
    // только на первое воспроизведение, и до него полоса была пустой рамкой.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => G.StereoEq.idle(), { once: true });
    } else {
        G.StereoEq.idle();
    }
})(window);
