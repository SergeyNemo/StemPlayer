'use strict';
(function (G) {
    const { state, els, API } = G;
    const {
        setBadge, showProgress, appendLog, renderLogs, hideBanner, fetchJson,
        rowWorking, rowDoneRow, rowErrorRow, refreshTracks, updateNav,
    } = G;

    // UI кнопки/прогресса: при генерации — «Идёт генерация»; когда все треки
    // уже разбиты — кнопку и полоску прогресса скрываем целиком. Если идёт
    // обработка треков (анализ) — генерацию не запускаем (взаимная блокировка).
    // Ссылки в шапке обновляем здесь же: это единственная точка, через которую
    // проходят ВСЕ смены состояния (renderTable, старт/финиш генерации, опрос).
    G.updateGenerateUI = function updateGenerateUI() {
        const allDone = state.rows.length > 0 && state.rows.every((r) => r.done);
        const gen = !!state.generating;
        const blocked = !!state.blocked;
        els.generateBtn.hidden = !gen && allDone && !blocked;
        els.generateBtn.disabled = gen || blocked;
        els.generateBtn.textContent = blocked && !gen
            ? 'Идёт обработка треков'
            : gen
                ? 'Идёт генерация'
                : 'Сгенерировать стемы';
        els.generateBtn.title = blocked && !gen ? 'Запустите после завершения обработки' : '';
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
        els.stopBtn.hidden = false;
        resetStopBtn();

        hideBanner();
        G.hideLogLine();
        setBadge('running');
        // Total — только треки без готовых стемов (готовые сервер пропустит).
        const todo = state.rows.filter((r) => !r.done).length;
        G.updateGenerateUI();
        appendLog({ time: '--:--:--', type: 'info', message: `Начинаю разделение (${todo || state.rows.length} трек(ов))…` });

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
                    finishGeneration('idle');
                } else if (res.status === 'idle') {
                    appendLog({ time: '--:--:--', type: 'warning', message: res.message || 'Нет треков для разделения.' });
                    finishGeneration('complete');
                } else if (res.status === 'error') {
                    appendLog({ time: '--:--:--', type: 'error', message: 'Не удалось запустить генерацию.' });
                    finishGeneration('error');
                }
            })
            .catch(() => {
                appendLog({ time: '--:--:--', type: 'error', message: 'Не удалось связаться с сервером при запуске генерации.' });
                finishGeneration('error');
            });

        G.startPolling(false);
    };

    function finishGeneration(status) {
        stopPolling();
        state.generating = false;
        state.launched = false;
        G.resetStopBtn();
        els.stopBtn.hidden = true;
        setBadge(status);
        G.updateGenerateUI();
    }

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
            appendLog({ time: '--:--:--', type: 'warning', message: 'Остановка удалит всё, что создал текущий прогон (каталоги стемов). Нажмите «Подтвердить».' });

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
        appendLog({ time: '--:--:--', type: 'warning', message: 'Запрошена остановка: завершаю текущий трек и откатываю прогон…' });
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
                setBadge(status);
                renderLogs(p.last_message);

                if (status === 'running') {
                    // Демон шлёт сердцебиение (last_ping) раз в 10 с, поэтому
                    // 120 с молчания — это уже точно не работающий процесс.
                    const stale = Number(p.last_ping || 0) > 0 && Date.now() / 1000 - Number(p.last_ping) > 120;

                    if (stale) {
                        stopPolling();
                        state.generating = false;
                        state.launched = false;
                        G.resetStopBtn();
                        els.stopBtn.hidden = true;
                        setBadge('idle');
                        G.updateGenerateUI();
                        appendLog({ time: '--:--:--', type: 'error', message: 'Фоновый процесс генерации не отвечает (завис). Состояние сброшено — запустите заново.' });
                        refreshTracks().catch(() => {});
                        return;
                    }

                    if (p.current_file) {
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
                    state.generating = false;
                    state.launched = false;
                    G.resetStopBtn();
                    els.stopBtn.hidden = true;
                    appendLog({ time: '--:--:--', type: status === 'complete' ? 'success' : 'warning', message: status === 'complete' ? 'Готово' : 'Остановлено' });
                    setTimeout(() => G.hideLogLine(), 3000);
                    G.updateGenerateUI();
                    refreshTracks().catch(() => {});
                }
            })
            .catch(() => { stopPolling(); });
    }
})(window.StemGen);