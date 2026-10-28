'use strict';
(function (G) {
    const { state, els, API } = G;
    const {
        showProgress, appendLog, renderLogs, fetchJson,
        rowWorking, rowDoneRow, rowErrorRow, refreshTracks, updateNav,
    } = G;

    // Сколько ждём первого 'running' после нажатия «Сгенерировать». Старт
    // демона на Windows занимает секунды (PHP + импорт torch), но не полминуты.
    const LAUNCH_WAIT_MS = 25000;

    // Имя трека, который демон обрабатывает прямо сейчас. Нужно, чтобы заметить
    // момент смены current_file: предыдущий трек к этому времени реально готов,
    // и ему можно погасить «генерация…» + полоску, поставив зелёное «Сгенерировано».
    let lastWorkingName = null;

    // UI кнопки/прогресса: при генерации — «Идёт генерация»; когда все треки
    // уже разбиты — кнопку и полоску прогресса скрываем целиком. Если идёт
    // обработка треков (анализ) — генерацию не запускаем (взаимная блокировка).
    // Ссылки в шапке обновляем здесь же: это единственная точка, через которую
    // проходят ВСЕ смены состояния (renderTable, старт/финиш генерации, опрос).
    G.updateGenerateUI = function updateGenerateUI() {
        const allDone = state.rows.length > 0 && state.rows.every((r) => r.done);
        const gen = !!state.generating;
        const blocked = !!state.blocked;
        const cascade = gen && !!state.cascadeId;
        els.generateBtn.hidden = !gen && allDone && !blocked;
        els.generateBtn.disabled = gen || blocked;
        els.generateBtn.textContent = blocked && !gen
            ? 'Идёт обработка треков'
            : cascade
                ? 'Идёт разделение'
                : gen
                    ? 'Идёт генерация'
                    : 'Сгенерировать стемы';
        els.generateBtn.title = blocked && !gen ? 'Запустите после завершения обработки' : '';
        // Видимость кнопки — признак «всё готово», по нему же разблокируется
        // play и решается судьба эквалайзера (table.css). Здесь он меняется, и
        // только здесь, поэтому дёргаем синхронизацию именно здесь.
        G.syncPlayButtons();
        G.syncCascadeButtons();
        showProgress(gen);
        updateNav();
    };

    // Генерация: сервер сам поднимает отдельный фоновый процесс (CLI-демон),
    // страница лишь опрашивает состояние — её можно свободно покидать.
    G.startGeneration = function startGeneration() {
        if (state.locked) return;
        if (state.blocked) {
            appendLog({ time: '--:--:--', type: 'error', message: 'Идёт обработка треков (анализ) — запустите генерацию после её завершения.' });
            return;
        }
        if (state.generating) return;

        state.launched = true;
        state.generating = true;
        // Демон поднимается отдельным процессом, поэтому progress.json ещё
        // какое-то время отдаёт остаток ПРЕДЫДУЩЕГО прогона (status 'complete').
        // Раньше такой остаток принимался за финал только что запущенного
        // прогона: опрос останавливался на первом же опросе, страница писала
        // «Готово» (зелёным), кнопка снова становилась активной — а демон между
        // тем работал. Приходилось жать «Сгенерировать» ещё раз, и только
        // тогда появлялся прогресс. Теперь до первого 'running' терминальные
        // статусы игнорируются.
        state.awaitingRun = true;
        state.launchedAt = Date.now();
        els.stopBtn.hidden = false;
        resetStopBtn();

        G.hideLogLine();
        G.updateGenerateUI();

        // Треки без стемов встают в очередь «В ожидании».
        state.rows.forEach((row) => {
            if (!row.done) G.rowWaiting(row.name);
        });

        fetchJson('start_generation')
            .then((res) => {
                if (!res) return;

                if (res.status === 'already_running') {
                    appendLog({ time: '--:--:--', type: 'warning', message: res.message || 'Генерация уже выполняется.' });
                } else if (res.status === 'blocked') {
                    appendLog({ time: '--:--:--', type: 'error', message: res.message || 'Сейчас идёт обработка треков.' });
                    finishGeneration();
                } else if (res.status === 'idle') {
                    appendLog({ time: '--:--:--', type: 'warning', message: res.message || 'Нет треков для разделения.' });
                    finishGeneration();
                } else if (res.status === 'error') {
                    appendLog({ time: '--:--:--', type: 'error', message: 'Не удалось запустить генерацию.' });
                    finishGeneration();
                }
            })
            .catch(() => {
                appendLog({ time: '--:--:--', type: 'error', message: 'Не удалось связаться с сервером при запуске генерации.' });
                finishGeneration();
            });

        G.startPolling(false);
    };

    function finishGeneration() {
        stopPolling();
        state.generating = false;
        state.launched = false;
        state.cascadeId = null;
        G.resetStopBtn();
        els.stopBtn.hidden = true;
        G.updateGenerateUI();
    }

    // Каскадное разделение Other (other → guitar/piano) отдельным демоном.
    // Кнопка уходит в спиннер, а дальше работа идёт как обычный прогон: общий
    // опрос покажет прогресс/«Стоп»/живой журнал, а по финалу refreshTracks
    // перерисует карточку — под Other появятся каналы Guitar и Piano.
    G.startCascade = function startCascade(id, channel) {
        if (state.locked) return;

        if (state.blocked) {
            appendLog({ time: '--:--:--', type: 'error', message: 'Идёт обработка треков — разделение запустите после её завершения.' });
            return;
        }

        if (state.generating) {
            appendLog({ time: '--:--:--', type: 'warning', message: 'Уже идёт разделение — дождитесь завершения.' });
            return;
        }

        if (channel) channel.setCascadeBusy(true);

        fetchJson('split_instrument&id=' + encodeURIComponent(id) + '&stem=other')
            .then((res) => {
                if (!res) {
                    if (channel) channel.setCascadeBusy(false);
                    return;
                }

                if (res.status === 'started') {
                    // Демон поднялся и уже пишет run_id (API дождался этого),
                    // поэтому подключаем штатный опрос генерации.
                    state.generating = true;
                    state.cascadeId = id;
                    state.awaitingRun = true;
                    state.launchedAt = Date.now();
                    els.stopBtn.hidden = false;
                    resetStopBtn();
                    G.hideLogLine();
                    G.updateGenerateUI();
                    G.startPolling(false);
                    return;
                }

                if (channel) channel.setCascadeBusy(false);

                appendLog({
                    time: '--:--:--',
                    type: res.status === 'error' ? 'error' : 'warning',
                    message: res.message || 'Не удалось запустить разделение.',
                });

                // «Уже разделено» — экран разошёлся с сервером: перечитаем.
                if (res.status === 'already_done') refreshTracks().catch(() => {});
            })
            .catch(() => {
                if (channel) channel.setCascadeBusy(false);
                appendLog({ time: '--:--:--', type: 'error', message: 'Не удалось связаться с сервером при запуске разделения.' });
            });
    };

    // Остановка с подтверждением: остановка прогона теперь откатывает всё,
    // что он создал (каталоги стемов), поэтому один клик без вопроса —
    // это удаление данных. Схема как на странице «Обработка»: решение принимает
    // дедлайн, таймер только убирает подпись.
    const STOP_ARM_MS = 3000;
    let stopArmedUntil = 0;
    let stopArmTimer = null;

    function resetStopBtn() {
        stopArmedUntil = 0;
        state.stopping = false;

        if (stopArmTimer !== null) {
            clearTimeout(stopArmTimer);
            stopArmTimer = null;
        }

        els.stopBtn.disabled = false;
        els.stopBtn.textContent = '■ Стоп';
    }

    G.resetStopBtn = resetStopBtn;

    G.requestStop = function requestStop() {
        if (state.stopping) return;

        if (Date.now() > stopArmedUntil) {
            stopArmedUntil = Date.now() + STOP_ARM_MS;
            els.stopBtn.textContent = 'Подтвердить';
            appendLog({
                time: '--:--:--',
                type: 'warning',
                message: state.cascadeId
                    ? 'Остановка прервёт каскадное разделение — guitar/piano не будут созданы. Нажмите «Подтвердить».'
                    : 'Остановка удалит всё, что создал текущий прогон (каталоги стемов). Нажмите «Подтвердить».',
            });

            if (stopArmTimer !== null) clearTimeout(stopArmTimer);
            stopArmTimer = setTimeout(() => {
                stopArmTimer = null;
                if (Date.now() >= stopArmedUntil && els.stopBtn.textContent === 'Подтвердить') {
                    stopArmedUntil = 0;
                    els.stopBtn.textContent = '■ Стоп';
                }
            }, STOP_ARM_MS + 50);

            return;
        }

        stopArmedUntil = 0;

        if (stopArmTimer !== null) {
            clearTimeout(stopArmTimer);
            stopArmTimer = null;
        }

        state.stopping = true;
        els.stopBtn.disabled = true;
        els.stopBtn.textContent = 'Останавливаю…';
        fetchJson('stop_generation').catch(() => {
            resetStopBtn();
            appendLog({ time: '--:--:--', type: 'error', message: 'Нет связи с сервером — запрос остановки не отправлен.' });
        });
    };

    // Опрос состояния каждые 2 секунды. Запуск здесь не бывает НИКОГДА: он
    // живёт только в startGeneration() выше. Страница может подключиться к
    // прогону (перезагрузка F5, второе окно) и следить за ним, но не
    // перезапускает его сама - так же, как страница «Обработка» вызывает
    // startPolling(false).
    G.startPolling = function startPolling() {
        stopPolling();

        // Подключились к идущему прогону: показываем «Стоп» и блокируем
        // кнопки, даже если запустил прогон не этот экземпляр страницы
        // (перезагрузка / второе окно). Раньше здесь ничего не выставлялось,
        // и после перезагрузки страница выглядела простаивающей: кнопка
        // «Сгенерировать» активна, «Стоп» скрыта, ссылка «Обработка» открыта.
        state.generating = true;
        els.stopBtn.hidden = false;
        G.resetStopBtn();
        G.updateGenerateUI();

        state.pollTimer = setInterval(pollProgress, 2000);
        pollProgress();
    };


    function stopPolling() {
        if (state.pollTimer !== null) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
        }
    }

    function pollProgress() {
        fetchJson('get_progress')
            .then((p) => {
                if (p.analysis_running !== undefined) {
                    state.blocked = !!p.analysis_running;
                }

                const status = p.status || 'idle';

                // Демон ещё не проснулся — терминальный статус не наш. Молча
                // ждём 'running' и не трогаем ни журнал, ни строки: иначе
                // мелькнёт зелёное «Готово» от старого прогона, а полоса
                // прогресса на треке пропадёт (finishGeneration -> refreshTracks).
                if (state.awaitingRun && status !== 'running') {
                    if (Date.now() - state.launchedAt > LAUNCH_WAIT_MS) {
                        state.awaitingRun = false;
                        appendLog({
                            time: '--:--:--',
                            type: 'error',
                            message: 'Демон не начал прогон за ' + Math.round(LAUNCH_WAIT_MS / 1000) + ' с — состояние сброшено, запустите заново.',
                        });
                        finishGeneration();
                        refreshTracks().catch(() => {});
                    }
                    return;
                }

                if (status === 'running') {
                    state.awaitingRun = false;
                }

                if (status === 'running') {
                    // Демон шлёт сердцебиение (last_ping) раз в 10 с, поэтому
                    // 120 с молчания — это уже точно не работающий процесс.
                    const stale = Number(p.last_ping || 0) > 0 && Date.now() / 1000 - Number(p.last_ping) > 120;

                    if (stale) {
                        stopPolling();
                        state.generating = false;
                        state.launched = false;
                        state.cascadeId = null;
                        G.resetStopBtn();
                        els.stopBtn.hidden = true;
                        G.updateGenerateUI();
                        appendLog({ time: '--:--:--', type: 'error', message: 'Фоновый процесс генерации не отвечает (завис). Состояние сброшено — запустите заново.' });
                        refreshTracks().catch(() => {});
                        return;
                    }

                    // Живая строка журнала прогона — единственная текстовая
                    // подпись под прогрессбаром. Терминальные last_message
                    // («Генерация завершена: обработано…», «Остановлено:
                    // обработано…») сюда НЕ идут: это итог прошлого прогона.
                    // Итог показываем один раз, когда прогон реально дошёл
                    // до конца, — см. logRunFinished ниже.
                    renderLogs(p.last_message);

                    if (p.current_file) {
                        // Демон перешёл к следующему треку — предыдущий уже
                        // сгенерирован. Раньше у него навсегда оставались
                        // «генерация…» и подпись «готово» последнего этапа,
                        // потому что трогали только текущий current_file.
                        if (lastWorkingName && lastWorkingName !== p.current_file) {
                            rowDoneRow(lastWorkingName);
                        }
                        lastWorkingName = p.current_file;

                        // Сначала «генерация…» (чип + показ полоски), затем
                        // текущий этап из демона: rowStage идёт вторым, иначе
                        // он был бы отброшен проверкой «строка ещё не в run».
                        rowWorking(p.current_file);
                        G.rowStage(p.current_file, p.current_stage_index, p.current_stage_label);
                    }
                    return;

                }

                if (G.TERMINAL.includes(status)) {
                    stopPolling();
                    lastWorkingName = null;
                    state.generating = false;
                    state.launched = false;
                    state.cascadeId = null;
                    G.resetStopBtn();
                    els.stopBtn.hidden = true;
                    // Итог прогона: отображаем однократно на LOG_FINAL_MS
                    // статусное сообщение демона из last_message.
                    if (status === 'stopped') {
                        G.logRunFinished(null, 'Остановлено');
                    } else {
                        G.logRunFinished(p.last_message, 'Готово');
                    }
                    G.updateGenerateUI();
                    refreshTracks().catch(() => {});
                }
            })
            .catch(() => { stopPolling(); });
    }
})(window.StemGen);