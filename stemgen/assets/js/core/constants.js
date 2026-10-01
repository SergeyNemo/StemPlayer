'use strict';

window.StemGen = window.StemGen || {};

// Константы модуля «Стемы».
(function (G) {
    G.API = 'stemgenApi.php';
    G.STEM_ORDER = ['other', 'vocals', 'bass', 'drums'];
    G.STEM_NAMES = { other: 'Музыка', vocals: 'Вокал', bass: 'Басс', drums: 'Ударные' };
    // Суффиксы сохраняемых файлов: other→music, vocals→vocal, bass→bass,
    // drums→drums. Ключи те же, что у STEM_ORDER, а слова — НЕ как в подписи
    // на экране (STEM_LABELS в ui/channel.js): подпись можно переименовать
    // когда угодно, а имя уже сохранённого файла меняться не должно. Поэтому
    // это отдельная карта, а не производная от подписи.
    G.STEM_FILE_SUFFIX = { other: 'music', vocals: 'vocal', bass: 'bass', drums: 'drums' };
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
