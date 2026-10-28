'use strict';

// Общее UI-ядро живёт в analysis/assets/js/core/ui.js и подключается в
// index.php первым. Здесь только правила модуля «Стемы».
(function (G) {
    const StemUI = window.StemUI;

    if (!StemUI) {
        throw new Error('Не загружено общее ядро assets/js/core/ui.js - подключи его в index.php до app.js');
    }

    // mm:ss из секунд.
    G.fmtTime = function fmtTime(s) {
        s = Math.max(0, Math.floor(s || 0));
        const m = Math.floor(s / 60), ss = s % 60;
        return `${m}:${String(ss).padStart(2, '0')}`;
    };

    // Имя файла для сохранения стема: имя трека «как есть» + вид стема.
    // Хвост исходного расширения отрезается, недопустимые символы заменяются.
    G.stemFileName = function stemFileName(trackName, kind) {
        const base = String(trackName == null ? '' : trackName)
            .replace(/\.[A-Za-z0-9]{1,5}$/, '') // хвост .mp3
            .replace(/[\\/:*?"<>|]/g, '_')      // Windows такие символы в имени не берёт
            .replace(/\s+/g, ' ')
            .replace(/[ .]+$/, '')
            .trim();

        return `${base || 'track'}_${G.STEM_FILE_SUFFIX[kind] || 'stem'}.mp3`;
    };

    // Ссылки в шапке блокирует общее ядро (analysis/assets/js/core/ui.js -
    // StemUI.createNav), чтобы «Обработка» и «Стемы» вели себя одинаково.
    // Здесь только правила этого модуля.
    //
    // Модуль «Обработка» недоступен как при активности соседнего процесса,
    // так и во время выполнения локальной генерации (ownBusy).
    //
    // href у ссылки остаётся всегда: клик по закрытой ссылке
    // ловит ядро и пишет в ленту причину блокировки.
    G.lockNav = window.StemUI.lockNav;

    // Своя страница открыта всегда (мы на ней), «Главная» закрыта, пока работает
    // кто угодно, соседний модуль — пока работает он, а «Обработка» — ещё и пока
    // работаем мы: демон один на оба модуля.
    G.updateNav = function updateNav() {
        const { state, els } = G;
        const ownBusy = !!state.generating;
        const otherRuns = !!state.blocked; // обработка треков идёт в другом окне

        StemUI.createNav({
            onBlocked: (reason) => G.appendLog({ time: '--:--:--', type: 'warning', message: reason }),
            links: [
                {
                    el: els.navHome,
                    busy: () => ownBusy || otherRuns,
                    reason: () => `Идёт ${otherRuns ? 'обработка треков' : 'генерация стемов'} — страница «Главная» сейчас закрыта`,
                },
                {
                    el: els.navAnalysis,
                    busy: () => ownBusy || otherRuns,
                    reason: () => (otherRuns
                        ? 'Идёт обработка треков — страница «Обработка» сейчас закрыта'
                        : 'Идёт генерация стемов — страница «Обработка» сейчас закрыта'),
                },
            ],
        })();
    };
})(window.StemGen);
