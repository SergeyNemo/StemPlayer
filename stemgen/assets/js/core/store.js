'use strict';
(function (G) {
    // Общее состояние таблицы и потоков: rows, rowRefs, tracksById, поллинг.
    G.state = {
        rows: [],
        rowRefs: new Map(), // name -> { tr, chip, fill, wrap }
        tracksById: new Map(), // id -> Track (буферы стемов кешируются)
        pollTimer: null,
        launched: false,
        generating: false, // идёт генерация и опрос демона
            stopping: false, // ждём завершения после нажатия «Стоп»
        locked: false, // нет ни одного обработанного трека (music/sorted пуст)
        blocked: false, // идёт обработка треков (анализ) — генерацию запускать нельзя
    };

    // Реестр каналов перебора: `${id}/${kind}` -> { track, stem, ch }.
    G.ui = new Map();
})(window.StemGen);