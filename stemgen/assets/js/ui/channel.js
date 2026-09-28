'use strict';
(function (G) {
    const { STEM_NAMES, LevelMeter, ensureSpec } = G;

    // Подписи стемов на латинице (в строке канала, слева от времени).
    const STEM_LABELS = { other: 'Music', vocals: 'Vocal', bass: 'Bass', drums: 'Drums' };

    // Канал стема: UI-обвязка одного стема + его явные состояния.
    // state: 'off' (трек не играет) | 'active' (трек играет, канал слышен)
    //        | 'muted' (канал выключен) | 'absent' (файла нет).
    class Channel {
        constructor(track, stem) {
            this.track = track;
            this.stem = stem;
            this.meter = new LevelMeter(stem);

            this.item = document.createElement('div');
            this.item.className = 'chan-pair';

            // Панель трека (волна, время) — сам канал.
            this.panel = document.createElement('div');
            this.panel.className = 'chan';

            // Основная область: фоновая волна + время.
            this.specEl = document.createElement('canvas');
            this.specEl.className = 'chan-spec';
            this.panel.prepend(this.specEl);

            // Время
            const trow = document.createElement('div');
            trow.className = 'chan-row chan-row-time';

            // Подпись стема. Раньше была отдельной колонкой слева от канала
            // (54px + четыре бокса) — от неё карточка разъезжалась на телефоне.
            // Теперь подпись стоит в одной строке со временем, слева.
            this.nameEl = document.createElement('span');
            this.nameEl.className = 'stem-chan-name';
            this.nameEl.textContent = STEM_LABELS[stem.kind] || stem.kind;
            this.nameEl.title = STEM_NAMES[stem.kind];

            this.timeEl = document.createElement('span');
            this.timeEl.className = 'chan-time';
            this.timeEl.textContent = '0:00';
            const sep = document.createElement('span');
            sep.className = 'chan-sep';
            sep.textContent = '/';
            this.durEl = document.createElement('span');
            this.durEl.className = 'chan-dur';
            this.durEl.textContent = '0:00';
            trow.append(this.nameEl, this.timeEl, sep, this.durEl);

        this.panel.append(this.specEl, trow);

        // Отдельный элемент справа от канала: EQ + галка включения.
        this.right = document.createElement('div');
        this.right.className = 'chan-right';

        // Галка = «канал включён»: стоит -> слышно. Снимается сама, когда
        // громкость доезжает до нуля, и возвращается, как только она > 0.
        this.muteBox = document.createElement('input');
        this.muteBox.type = 'checkbox';
        this.muteBox.className = 'chan-mute';
        this.muteBox.disabled = !stem.hasAudio;
        this.muteBox.checked = stem.enabled;
        this.muteBox.addEventListener('change', () => this.stem.setEnabled(this.muteBox.checked));

        this.right.append(this.meter.pct, this.meter.el, this.muteBox);

        this.item.append(this.panel, this.right);

        // Любая правка громкости/мута перерисовывает и галку, и подпись.
        stem.onMix = () => this.syncMixUI();

        if (stem.hasAudio) {
            ensureSpec(stem);
        }

        this.setState();
    }

        get state() {
            return this.stem.state; // 'absent' | 'muted' | 'active'
        }

        // Применяем CSS-состояния канала.
        setState() {
            const s = this.state;
            this.item.classList.toggle('is-muted', s === 'muted');
            this.item.classList.toggle('is-absent', s === 'absent');
        }

        // Единая точка правки UI микса: галка, подпись процентов, вид канала.
        syncMixUI() {
            this.muteBox.checked = this.stem.enabled;
            this.muteBox.title = this.stem.enabled
                ? 'Канал включён — щёлкните, чтобы приглушить'
                : 'Канал выключен — щёлкните, чтобы вернуть громкость';
            this.meter.update();
            this.setState();
        }

        // Воспроизведение трека началось/закончилось (для данного канала).
        setPlaying(isActive) {
            this.item.classList.toggle('is-playing', isActive);
        }
    }

    G.Channel = Channel;
})(window.StemGen);