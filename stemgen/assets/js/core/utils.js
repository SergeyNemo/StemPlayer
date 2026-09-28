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

    // Ссылки в шапке блокирует общее ядро (analysis/assets/js/core/ui.js -
    // StemUI.createNav), чтобы «Обработка» и «Стемы» вели себя одинаково.
    // Здесь только правила этого модуля.
    //
    // ВАЖНО: «Обработка» закрыта не только когда её крутит сосед, но и
    // когда работаем мы сами. Раньше ownBusy не учитывался, и во время
    // генерации ссылка «Обработка треков» выглядела и работала как
    // обычная — пользователь уходил со страницы, где идёт работа.
    //
    // href у ссылки остаётся всегда: <a> без href не кликается, и
    // нажатие выглядит как «ничего не произошло». Клик по закрытой
    // ссылке ловит ядро и пишет в ленту, почему перехода не будет.
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
