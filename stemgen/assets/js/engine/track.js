'use strict';
(function (G) {
    const { Stem } = G;

    // Трек = 4 стема, стартуют BufferSource-ами с одинаковым ctx-временем.
    class Track {
        constructor(id, name) {
            this.id = id;
            this.name = name;
            this.stems = [];
        }

        // Пересобираем стемы по строке таблицы: прежние объекты переиспользуются,
        // если URL стема не менялся (декодированный буфер сохраняется).
        addStems(row) {
            const revs = row.stem_revs || {};
            const fresh = G.STEM_ORDER.map((kind) => {
                const url = (row.stems && row.stems[kind]) || null;
                const rev = revs[kind] || 0;
                const prev = this.stems.find((s) => s.kind === kind);
                // Ревизия в сравнении обязательна: после перегенерации URL тот
                // же (id строится из имени/bpm/тональности), меняется mtime.
                return prev && prev.url === url && prev.rev === rev ? prev : new Stem(kind, url, rev);
            });
            this.stems = fresh;
        }

        async prepare(ctx) {
            await Promise.all(this.stems.filter((s) => s.url).map((s) => s.load(ctx)));
        }

        // Длительность трека по уже загруженным стемам. До первого play
        // буферов нет и она равна 0 — перемотку по доли это не ломает,
        // Player ждёт prepare() и пересчитывает долю в секунды сам.
        get duration() {
            return this.stems.reduce((m, s) => (s.buffer ? Math.max(m, s.duration) : m), 0);
        }

        // offset — общая точка старта для всех стемов: стемы играют из одного
        // момента, поэтому и перематываются вместе (одним offset).
        play(when, onAllEnd, offset) {
            const playing = this.stems.filter((s) => s.url);
            let ended = 0;
            const onStemEnd = () => {
                ended += 1;
                if (onAllEnd && ended >= playing.length) onAllEnd(this);
            };
            playing.forEach((s) => s.play(when, onStemEnd, offset));
        }

        stop() { this.stems.forEach((s) => s.stop()); }
    }

    G.Track = Track;
})(window.StemGen);