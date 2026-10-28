'use strict';
(function (G) {
    const { state, ui, els, player, Channel, Track, showProgress, appendLog, fetchJson } = G;

    // Каналы стемов в карточке трека. Подпись стема теперь живёт в самом
    // канале (слева от времени), поэтому отдельная колонка-бокс не нужна.
    //
    // Порядок: 4 базовых стема, а каскадные (guitar/piano) встают сразу ПОД
    // Other — и только если файлы реально есть (иначе старые треки выглядели
    // бы с пустыми каналами).
    G.buildChannelList = function buildChannelList(track, row) {
        const list = document.createElement('div');
        list.className = 'stem-list';

        const order = [];

        G.STEM_ORDER.forEach((kind) => {
            order.push(kind);

            if (kind === 'other') {
                (G.STEM_CASCADE_ORDER || []).forEach((ck) => {
                    const cs = track.stems.find((s) => s.kind === ck);
                    if (cs && cs.url) order.push(ck);
                });
            }
        });

        order.forEach((stemKind) => {
            const stem = track.stems.find((s) => s.kind === stemKind);
            if (!stem) return;
            const key = `${track.id}/${stemKind}`;
            const ch = new Channel(track, stem);
            list.appendChild(ch.item);
            ui.set(key, { track, stem, ch });
        });

        return list;
    };

    G.syncPlayingUI = function syncPlayingUI() {
        const active = player.activeTrack;
        ui.forEach((r) => {
            const isActive = active !== null && active.id === r.track.id;
            r.ch.setPlaying(isActive);
        });
        // Задний фон EQ рисуется ровно в одном месте — в боксе названия
        // играющего трека; у остальных строк canvas пустой и скрыт.
        let eqCanvas = null;
        state.rowRefs.forEach((ref) => {
            const isActive = active !== null && !!ref.trackId && ref.trackId === active.id;
            if (ref.playBtn) ref.playBtn.classList.toggle('is-active', isActive);
            if (ref.nameBox) ref.nameBox.classList.toggle('is-live', isActive);
            if (isActive) eqCanvas = ref.nameEq;
        });
        G.setTitleEq(eqCanvas);
    };

    // Таблица: сборка карточек и обновление строк.
    G.renderTable = function renderTable() {
        els.tbody.innerHTML = '';
        state.rowRefs.clear();
        ui.clear();

        if (state.rows.length === 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.className = 'col-center';
            td.textContent = 'В music/sorted/ пока нет треков — сначала обработайте их в модуле «Обработка».';
            tr.appendChild(td);
            els.tbody.appendChild(tr);
            showProgress(false);
            return;
        }

        state.rows.forEach((row) => {
            // Объект трека: переиспользуем по id, буферы стемов кешируются.
            let track = state.tracksById.get(row.id);
            if (!track) {
                track = new Track(row.id, row.name);
                state.tracksById.set(row.id, track);
            }
            track.addStems(row);

            const tr = document.createElement('tr');
            if (row.done) tr.classList.add('row-done');

            const td = document.createElement('td');

            const card = document.createElement('div');
            card.className = 'track-card';

            // Верхняя полоса: Название | BPM | Key в одном стиле.
            const main = document.createElement('div');
            main.className = 'card-main';

            const strip = document.createElement('div');
            strip.className = 'meta-strip';

            const mkMeta = (label, value) => {
                const item = document.createElement('div');
                item.className = 'meta-item';
                const lab = document.createElement('span');
                lab.className = 'meta-label';
                lab.textContent = label;
                const val = document.createElement('b');
                val.className = 'meta-value';
                val.textContent = value;
                item.append(lab, val);
                return item;
            };

            const nameBox = document.createElement('div');
            nameBox.className = 'meta-item meta-name';
            // Задний план: спектр играющего трека. position:absolute в CSS,
            // поэтому ширину бокса (а значит и раскладку всей полосы) не
            // трогает — ровно та же идея, что с шириной подписи громкости.
            const nameEq = document.createElement('canvas');
            nameEq.className = 'name-eq';
            nameBox.appendChild(nameEq);
            const nameVal = document.createElement('b');
            nameVal.className = 'meta-value';
            nameVal.textContent = row.name;
            nameBox.appendChild(nameVal);

            // Единая кнопка play в боксе справа от Key.
            const playBtn = document.createElement('button');
            playBtn.type = 'button';
            playBtn.className = 'chan-play card-play';
            playBtn.disabled = G.playLocked() || !row.done;
            const pPlay = document.createElement('span');
            pPlay.className = 'stem-pause';
            pPlay.append(document.createElement('i'), document.createElement('i'));
            playBtn.append(G.playIcon(), pPlay);
            if (row.done) {
                playBtn.title = 'Играть / пауза';
                playBtn.addEventListener('click', () => player.toggle(track));
            } else {
                playBtn.title = 'Стемов ещё нет';
            }

            const playBox = document.createElement('div');
            playBox.className = 'meta-item meta-play';
            const playLab = document.createElement('span');
            playLab.className = 'meta-label';
            playLab.textContent = 'Play';
            const playWrap = document.createElement('div');
            playWrap.className = 'meta-play-btn';
            playWrap.appendChild(playBtn);
            // Именно append, а не appendChild: appendChild берёт ОДИН узел, и
            // playWrap (а в нём кнопка со значком) молча не попадал в DOM —
            // оставался пустой бокс с надписью «Play» без значка.
            playBox.append(playLab, playWrap);

            strip.append(
                nameBox,
                mkMeta('BPM', row.bpm != null ? String(row.bpm) : '—'),
                mkMeta('Key', row.key || '—'),
                playBox
            );

            main.appendChild(strip);

            const stemRow = document.createElement('div');
            stemRow.className = 'card-stem-row';

            let chip, wrap, fill, stageLab;

            if (row.done) {
                // Готовые стемы: каналы на всю ширину карточки. Постоянной
                // отметки здесь нет намеренно: после прогона перерисовываются
                // все строки, и у готового трека не остаётся никакой подписи —
                // «✓ Сгенерировано» живёт только на время генерации, пока
                // видно, что трек дошёл до конца.
                stemRow.appendChild(G.buildChannelList(track, row));
            } else {
                // Стемов ещё нет — только статус и анимированная полоска:
                // генерация запускается общей кнопкой сверху.
                const empty = document.createElement('div');
                empty.className = 'card-empty';

                chip = document.createElement('span');
                chip.className = 'stem-chip';
                chip.hidden = true;

                wrap = document.createElement('div');
                wrap.className = 'cell-progress card-progress is-staged';
                // сегментов столько же, сколько этапов в constants.js
                wrap.style.setProperty('--stages', String(G.STEM_STAGES.length));
                wrap.hidden = true;
                fill = document.createElement('div');
                fill.className = 'cell-fill';
                wrap.appendChild(fill);

                stageLab = document.createElement('span');
                stageLab.className = 'cell-stage';
                stageLab.hidden = true;

                empty.append(chip, wrap, stageLab);
                stemRow.appendChild(empty);
            }

            main.appendChild(stemRow);

            card.appendChild(main);
            td.appendChild(card);
            tr.appendChild(td);
            els.tbody.appendChild(tr);

            // done держим в ref: G.syncPlayButtons обходит готовые строки без
            // перерисовки таблицы, а перечитывать get_tracks ради одного флага
            // рано — тем более что он меняется на ходу прогона.
            state.rowRefs.set(row.name, { tr, chip, fill, wrap, stageLab, stageShown: -1, playBtn, trackId: row.id, nameBox, nameEq, done: !!row.done });
        });

        G.syncPlayingUI();
        G.updateGenerateUI();
    };

    // Обновление строки: чип статуса + индетерминированная полоска «генерация…».
    G.setRowState = function setRowState(name, chipText, chipCls) {
        const ref = state.rowRefs.get(name);
        if (!ref) return;

        if (ref.chip) {
            ref.chip.classList.remove('ok', 'err', 'run', 'wait');
            if (chipCls) ref.chip.classList.add(chipCls);
            ref.chip.textContent = chipText;
            ref.chip.hidden = false;
        }

        if (ref.wrap) {
            const running = chipCls === 'run';
            ref.wrap.hidden = !running;

            if (running) {
                // Полосу теперь ведёт не «бесконечная анимация», а реальный
                // этап из демона (G.rowStage). Поэтому сбрасываем в 0 и ждём
                // первого current_stage_index, который придёт следующим же
                // ответом get_progress, - раньше, чем progress.json его
                // запишет, строка всё равно не рисуется.
                ref.fill.classList.remove('is-busy');
                ref.fill.style.width = '0%';
                ref.stageShown = -1;

                if (ref.stageLab) {
                    ref.stageLab.hidden = false;
                    ref.stageLab.textContent = 'старт';
                }
            } else {
                ref.fill.classList.remove('is-busy');
                ref.fill.style.width = '0%';
                ref.stageShown = -1;

                if (ref.stageLab) {
                    ref.stageLab.hidden = true;
                    ref.stageLab.textContent = '';
                }
            }
        }

        // Классы строки меняем только для «финальных» статусов.
        if (ref.tr && ['run', 'ok', 'err'].includes(chipCls)) {
            ref.tr.classList.remove('row-processing', 'row-done', 'row-error');
            if (chipCls === 'run') ref.tr.classList.add('row-processing');
            if (chipCls === 'ok') ref.tr.classList.add('row-done');
            if (chipCls === 'err') ref.tr.classList.add('row-error');
        }
    };

    // Очередь: трек ещё ждёт своей генерации.
    G.rowWaiting = function rowWaiting(name) {
        G.setRowState(name, 'В ожидании', 'wait');
    };

    G.rowWorking = function rowWorking(name) {
        G.setRowState(name, 'генерация…', 'run');
    };

    // Текущий этап разбиения трека: заполняем сегментированную шкалу по номеру
    // этапа (current_stage_index) и подписываем его человеческим языком.
    //
    // Ширину считает общий StemUI.stagePercent - ровно так же считает
    // «Обработка», поэтому обе шкалы растут одинаково. Повторный тот же этап
    // пропускаем (ref.stageShown), иначе transition запускался бы каждые 2 с
    // и анимация дёргалась бы даже когда ничего не изменилось.
    G.rowStage = function rowStage(name, stageIndex, stageLabel) {
        const ref = state.rowRefs.get(name);
        if (!ref || !ref.wrap || ref.wrap.hidden) return;

        if (typeof stageIndex !== 'number' || stageIndex < 0) return;

        const percent = window.StemUI.stagePercent(stageIndex, G.STEM_STAGES.length);
        if (ref.stageShown === percent) return;

        ref.stageShown = percent;
        ref.fill.style.width = percent + '%';
        ref.fill.dataset.stage = String(stageIndex);

        if (ref.stageLab) {
            ref.stageLab.hidden = false;
            ref.stageLab.textContent = stageLabel || G.STEM_STAGE_LABELS[G.STEM_STAGES[stageIndex]] || '';
        }
    };

    // Блокировка play — по кнопке «Сгенерировать стемы», а не по mode
    // прогенерации: пока кнопка на экране, все треки не разбиты и играть не
    // во что; как только updateGenerateUI её спрятал (всё готово) — play
    // разложен, даже если прогон останавливали. То же условие у эквалайзера
    // в table.css: кнопка есть — EQ не показываем.
    G.playLocked = function playLocked() {
        return !!els.generateBtn && !els.generateBtn.hidden;
    };
    G.syncPlayButtons = function syncPlayButtons() {
        const locked = G.playLocked();
        state.rowRefs.forEach((ref) => {
            if (!ref.playBtn) return;
            const done = ref.done;
            ref.playBtn.disabled = locked || !done;
            ref.playBtn.title = locked ? 'Генерация идёт' : done ? 'Играть / пауза' : 'Стемов ещё нет';
        });
    };

    // Кнопки каскада блокируем на время любого прогона (генерация/разделение —
    // демон один) и на время собственного запроса канала. Вызывается из
    // updateGenerateUI — единственной точки смены состояния прогона.
    G.syncCascadeButtons = function syncCascadeButtons() {
        const locked = !!state.generating || !!state.blocked;
        ui.forEach((r) => {
            if (r.ch && r.ch.cascadeBtn) {
                r.ch.cascadeBtn.disabled = locked || !!r.ch.cascadeBusy;
            }
        });
    };

    G.rowDoneRow = function rowDoneRow(name) {
        const ref = state.rowRefs.get(name);
        if (ref) {
            ref.tr.classList.remove('row-processing', 'row-error');
            ref.tr.classList.add('row-done');
            // Стем только что появился: снимаем блокировку play по факту, не
            // дожидаясь перерисовки таблицы. Пока на экране кнопка
            // «Сгенерировать стемы», syncPlayButtons оставит кнопку заблокированной.
            ref.done = true;
        }
        // Зелёный чип — статус завершения генерации.
        G.setRowState(name, '✓ Сгенерировано', 'ok');
        G.syncPlayButtons();
    };

    G.rowErrorRow = function rowErrorRow(name, message) {
        const ref = state.rowRefs.get(name);
        if (ref) {
            ref.tr.classList.remove('row-processing', 'row-done');
            ref.tr.classList.add('row-error');
        }
        G.setRowState(name, 'ошибка', 'err');
        appendLog({ time: '--:--:--', type: 'error', message: `${name}: ${message}` });
    };

    // Замок страницы: пока в music/sorted нет ни одного обработанного трека —
    // показываем заглушку вместо таблицы (нечего выводить).
    G.setLocked = function setLocked(locked) {
        state.locked = locked;
        if (els.lockScreen) els.lockScreen.hidden = !locked;
        if (els.tracksView) els.tracksView.hidden = locked;
    };

    // Сбор данных: перечитать список и перерисовать.
    G.refreshTracks = async function refreshTracks() {
        const data = await fetchJson('get_tracks');
        state.rows = data.rows || [];
        state.blocked = !!(data.analysis_running); // взаимная блокировка: идёт обработка
        G.setLocked(state.rows.length === 0);
        G.renderTable();
    };
})(window.StemGen);