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
            const fresh = G.STEM_ORDER.map((kind) => {
                const url = (row.stems && row.stems[kind]) || null;
                const prev = this.stems.find((s) => s.kind === kind);
                return prev && prev.url === url ? prev : new Stem(kind, url);
            });
            this.stems = fresh;
        }

        async prepare(ctx) {
            await Promise.all(this.stems.filter((s) => s.url).map((s) => s.load(ctx)));
        }

        play(when, onAllEnd) {
            const playing = this.stems.filter((s) => s.url);
            let ended = 0;
            const onStemEnd = () => {
                ended += 1;
                if (onAllEnd && ended >= playing.length) onAllEnd(this);
            };
            playing.forEach((s) => s.play(when, onStemEnd));
        }

        stop() { this.stems.forEach((s) => s.stop()); }
    }

    G.Track = Track;
})(window.StemGen);