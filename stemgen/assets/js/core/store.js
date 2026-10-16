'use strict';
(function (G) {
    // Общее состояние таблицы и потоков: rows, rowRefs, tracksById, поллинг.
    G.state = {
        rows: [],
        rowRefs: new Map(), // name -> { tr, chip, fill, wrap }
        tracksById: new Map(), // id -> Track (буферы стемов кешируются)
        pollTimer: null,
        launched: false, // прогон запущен этой страницей
        generating: false, // идёт генерация и опрос демона
        stopping: false, // ждём завершения после нажатия «Стоп»
        locked: false, // нет ни одного обработанного трека (music/sorted пуст)
        blocked: false, // идёт обработка треков (анализ) — генерацию запускать нельзя
        // Ждём первого 'running' после нажатия «Сгенерировать»: до этого
        // момента терминальный статус в progress.json — остаток прошлого
        // прогона, а не финал текущего.
        awaitingRun: false,
        launchedAt: 0, // когда нажали «Сгенерировать» (мс)
        // ID трека, для которого идёт каскадное разделение (null — обычный
        // прогон). Нужен, чтобы подпись кнопки/прогона говорила «разделение».
        cascadeId: null,
    };

    // Реестр каналов перебора: `${id}/${kind}` -> { track, stem, ch }.
    G.ui = new Map();
})(window.StemGen);