'use strict';

window.StemGen = window.StemGen || {};

// Константы модуля «Стемы».
(function (G) {
    G.API = 'stemgenApi.php';
    G.STEM_ORDER = ['other', 'vocals', 'bass', 'drums'];
    G.STEM_NAMES = { other: 'Музыка', vocals: 'Вокал', bass: 'Басс', drums: 'Ударные' };
    G.TYPE_LABELS = { info: 'ИНФО', success: 'OK', error: 'ОШИБКА', warning: 'ПРЕД' };
    G.TERMINAL = ['complete', 'error', 'stopped'];

    // Этапы разбиения трека — тот же список, что шлёт stem_splitter.py
    // ({"stage": …}) и хранит ProgressStore::STEMGEN_STAGES на стороне PHP.
    // Порядок задаёт позицию сегмента на шкале, поэтому он должен совпадать
    // с PHP: иначе сегмент подсветится не там, где идёт реальная работа.
    G.STEM_STAGES = ['load', 'demucs', 'collect', 'save', 'done'];
    G.STEM_STAGE_LABELS = {
        load: 'подготовка',
        demucs: 'разделение моделью',
        collect: 'сборка стемов',
        save: 'сохранение и проверка',
        done: 'готово',
    };
})(window.StemGen);
