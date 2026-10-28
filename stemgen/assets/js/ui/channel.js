'use strict';
(function (G) {
    const { STEM_NAMES, LevelMeter, ensureSpec } = G;

    // Подписи стемов на латинице (в строке канала, слева от времени).
    const STEM_LABELS = {
        other: 'Other', vocals: 'Vocal', bass: 'Bass', drums: 'Drums',
        guitar: 'Guitar', piano: 'Piano',
    };

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

            // Кнопка «сохранить стем» — перед подписью, отдельным узлом (не
            // обёрткой вокруг неё): у .stem-chan-name свой ellipsis, и если
            // завернуть иконку внутрь, обрезка длинной подписи поедет.
            // pointerdown гасим отдельно от click: панель канала целиком
            // ловит его для перемотки (bindSeek ниже), и без этого клик по
            // иконке ещё и перематывал бы трек.
            this.saveBtn = document.createElement('button');
            this.saveBtn.type = 'button';
            this.saveBtn.className = 'chan-save';
            this.saveBtn.appendChild(G.saveIcon());
            this.saveBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
            this.saveBtn.addEventListener('click', (e) => this.saveStem(e));
            this.syncSaveBtn();

            this.timeEl = document.createElement('span');
            this.timeEl.className = 'chan-time';
            this.timeEl.textContent = '0:00';
            const sep = document.createElement('span');
            sep.className = 'chan-sep';
            sep.textContent = '/';
            this.durEl = document.createElement('span');
            this.durEl.className = 'chan-dur';
            this.durEl.textContent = '0:00';
            trow.append(this.saveBtn, this.nameEl, this.timeEl, sep, this.durEl);

        this.panel.append(this.specEl, trow);

        // Кнопка каскада — в левом НИЖНЕМ углу канала: зеркало верхнего
        // левого угла (папка + подпись Other). Позиционируется абсолютно
        // (см. .btn-cascade-split в CSS), поэтому строку времени не растит и
        // не сдвигает. Только у Other, только когда стем на месте и трек ещё
        // не разделён на guitar/piano.
        this.cascadeBtn = null;

        if (stem.kind === 'other' && stem.hasAudio && !track.cascadeReady) {
            this.cascadeBtn = document.createElement('button');
            this.cascadeBtn.type = 'button';
            this.cascadeBtn.className = 'btn-cascade-split';
            this.cascadeBtn.textContent = 'Разделить (🎸/🎹)';
            this.cascadeBtn.title = 'Разделить Other на гитару и пиано (модель htdemucs_6s)';
            this.cascadeBtn.setAttribute('aria-label', 'Разделить Other на гитару и пиано');
            // pointerdown гасим отдельно от click: панель канала ловит его
            // для перемотки (bindSeek), иначе клик по кнопке ещё и мотал бы.
            this.cascadeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
            this.cascadeBtn.addEventListener('click', (e) => this.splitInstrument(e));
            this.panel.appendChild(this.cascadeBtn);
        }

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
            this.bindSeek();
        } else {
            this.panel.title = 'Файла стема нет';
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

    // Состояние кнопки «сохранить»: недоступна, пока файла нет или идёт
    // скачивание. Подсказка отображает итоговое имя файла вида «Artist - Song_vocal.mp3».
    syncSaveBtn() {
        if (!this.saveBtn) return;
        const has = this.stem.hasAudio;
        const hint = has
            ? `Сохранить стем: ${G.stemFileName(this.track.name, this.stem.kind)}`
            : 'Файла стема нет';

        this.saveBtn.title = hint;
        this.saveBtn.setAttribute('aria-label', hint);
        this.saveBtn.disabled = !has || !!this.saveBusy;
    }

    // Сохранение стема в файл с именем трека. Пока идёт запрос — кнопка
    // гаснет: повторные клики плодили бы копии одного и того же файла.
    saveStem(e) {
        e.preventDefault();
        e.stopPropagation();
        if (this.saveBusy || !this.stem.hasAudio) return;

        this.saveBusy = true;
        this.saveBtn.classList.add('is-busy');
        this.syncSaveBtn();

        G.downloadStem(this.stem, this.track.name).finally(() => {
            this.saveBusy = false;
            this.saveBtn.classList.remove('is-busy');
            this.syncSaveBtn();
        });
    }

    // Каскадное разделение Other (other) на guitar/piano. Работу запускает
    // отдельный демон, поэтому здесь только запрос и состояние кнопки —
    // прогресс и финал ведёт общий опрос (services/generation.js).
    splitInstrument(e) {
        e.preventDefault();
        e.stopPropagation();
        if (this.cascadeBusy || !this.cascadeBtn) return;
        G.startCascade(this.track.id, this);
    }

    // Состояние кнопки каскада: «Разделение…» + спиннер, пока идёт запрос.
    setCascadeBusy(busy) {
        if (!this.cascadeBtn) return;
        this.cascadeBusy = !!busy;
        this.cascadeBtn.disabled = !!busy;
        this.cascadeBtn.classList.toggle('is-loading', !!busy);
        this.cascadeBtn.textContent = busy ? 'Разделение…' : 'Разделить (🎸/🎹)';
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

    // Перемотка кликом и перетаскиванием по любой стемной волне.
    // Клик по месту, где играет, — перемотка на месте; клик по остановленному
    // треку — старт с этого места. Правую кнопку игнорируем (контекстное меню).
    bindSeek() {
        const panel = this.panel;
        let dragging = false;

        const seekTo = (e) => {
            // Во время прогона (генерация/разделение) play заблокирован кнопкой
            // «Сгенерировать» (G.playLocked). Панель канала — тот же play: клик
            // по волне стартует/перематывает трек, поэтому и здесь молчим —
            // иначе выходило «play-кнопки залочены, а клик по стему играет».
            if (G.playLocked()) return;
            const rect = panel.getBoundingClientRect();
            if (!rect.width) return;
            const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            G.player.seekTo(this.track, frac);
        };

        panel.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (G.playLocked()) return; // идёт прогон — перемотка запрещена
            e.preventDefault();
            dragging = true;
            try { panel.setPointerCapture(e.pointerId); } catch (err) { /* нет захвата */ }
            seekTo(e);
        });
        panel.addEventListener('pointermove', (e) => {
            if (dragging) seekTo(e);
        });
        const end = () => { dragging = false; };
        panel.addEventListener('pointerup', end);
        panel.addEventListener('pointercancel', end);

        panel.classList.add('is-seekable');
        panel.title = 'Щёлкните или потяните — перемотать с этого места';
    }
}

    G.Channel = Channel;
})(window.StemGen);