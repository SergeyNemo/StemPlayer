'use strict';
(function (G) {
    const { els, state, player } = G;
    const {
        fmtTime, drawTitleEq, drawSpecs, updateEqUi, syncPlayingUI,
        refreshTracks, startGeneration, requestStop, startPolling, fetchJson,
    } = G;

    // Время каналов: текущее и длительность.
    function updateTimes() {
        G.ui.forEach((r) => {
            r.ch.durEl.textContent = fmtTime(r.stem.duration);
            r.ch.timeEl.textContent = fmtTime(r.stem.currentTime);
        });
    }

    // Цикл: спектр названия + волны + часы + уровнемеры.
    function frame() {
        window.requestAnimationFrame(frame);
        drawTitleEq();
        drawSpecs();
        updateTimes();
        updateEqUi();
    }

    player.onChange = () => syncPlayingUI();

    els.generateBtn.addEventListener('click', startGeneration);
    els.stopBtn.addEventListener('click', requestStop);

    window.addEventListener('pagehide', () => player.stop());

    frame();

    refreshTracks()
        .then(() => {
            // Пока нет ни одного обработанного трека — страница залочена,
            // генерацию в другом окне тоже не подхватываем.
            if (state.locked) return;
            return fetchJson('get_progress').then((p) => {
                if (p.status !== 'running') return;

                G.setBadge('running');
                G.appendLog({
                    time: '--:--:--',
                    type: 'info',
                    message: 'Обнаружена идущая генерация (другое окно или перезагрузка). Слежу за прогрессом, заново не запускаю.',
                });

                startPolling(false);
            }).catch(() => {});
        })
        .catch(() => {});
})(window.StemGen);