import { state, els, TERMINAL_STATES, POLL_INTERVAL } from './store.js?v=93';
import { fetchJson, appendLog, logRunFinished, renderLogs, updateProcessUI, hideLogLine } from './utils.js?v=93';
import { rowProcessing, rowQueued, rowDone, rowError, rebuildRowIdle, syncDeleteButtons } from './table.js?v=93';
import { syncPlayButtons } from './player.js?v=93';
import { refreshInbox } from './upload.js?v=93';

// Демон шлёт сердцебиение (last_ping) раз в 10 с, поэтому 120 с молчания —
// это уже точно не работающий процесс.
function isStaleRun(progress) {
    const ping = Number(progress && progress.last_ping || 0);

    return ping > 0 && Date.now() / 1000 - ping > 120;
}

// Сколько ждём первого 'running' после нажатия «Обработать». Старт демона на
// Windows занимает до нескольких секунд (PHP + импорт torch), но не полминуты:
// если за это время 'running' не появился — запуска не было.
const LAUNCH_WAIT_MS = 25000;

function recoverDeadRun() {
    stopPolling();
    state.mode = 'idle';
    state.stopping = false;
    els.stopBtn.hidden = true;
    updateProcessUI();
    syncPlayButtons();
    syncDeleteButtons();
    appendLog({ time: '--:--:--', type: 'error', message: 'Фоновый процесс обработки не отвечает (завис). Состояние сброшено — запустите заново.' });
    refreshInbox();
}

// Финал неудачного старта. Отдельной строкой об ошибке: индикатор статуса
// удалён, и если запуска не было, в журнале не появится ни одного записи
// от демона — молчание читалось бы как «всё в порядке».
function finishProcessing() {
    stopPolling();
    state.mode = 'idle';
    state.stopping = false;
    els.stopBtn.hidden = true;
    updateProcessUI();
    syncPlayButtons();
    syncDeleteButtons();
}

// Запуск обработки: сервер сам поднимает отдельный фоновый процесс (CLI-демон),
// поэтому страницу можно свободно покидать — обработка никуда не исчезнет.
function startProcessing() {
    if (state.stemgenRunning) {
        appendLog({ time: '--:--:--', type: 'error', message: 'Идёт генерация стемов — запустите обработку после её завершения.' });
        return;
    }

    state.stopping = false;
    state.sawRun = false;
    stopPolling();

    els.stopBtn.hidden = false;
    resetStopBtn();
    hideLogLine();
    updateProcessUI();

    state.rowRefs.forEach((ref) => {
        ref.tr.classList.remove('row-done', 'row-error', 'row-processing');
        rebuildRowIdle(ref, true);
        ref.bpmCell.textContent = '—';
        ref.keyCell.textContent = '—';
        ref.durCell.textContent = '—';
    });
    syncPlayButtons();
    syncDeleteButtons();

    startPolling(true);
}

// ---------- Остановка ----------

// Подтверждение остановки держим на одном числе-дедлайне, а не на объекте
// с ключом state.mode и не на таймере. Прежняя схема давала петлю
// «Стоп → Подтвердить → Стоп → …» тремя способами:
//   1) state.mode меняется между кликами (idle/done), ключ менялся — второе
//      нажатие снова взводило защёлку вместо остановки;
//   2) таймер взвода никогда не отменялся при подтверждении и мог сработать
//      поверх следующего нажатия, молча вернув подпись «■ Стоп»;
//   3) любой ответ сервера, кроме 'ok', возвращал кнопку в «Стоп» без
//      объяснения — выглядело как бесконечное «подтвердить и ничего».
// Теперь решение принимается только по дедлайну, таймер лишь убирает
// подпись, а «не остановилось» всегда объясняется строкой в журнале.
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

function requestStop() {
    if (state.stopping) return;

    // Первое нажатие — взвод. Подпись живёт 3 секунды, после неё тихо
    // возвращаемся к «Стоп», но на следующем нажатии решение всё равно
    // примет дедлайн, а не этот таймер.
    if (Date.now() > stopArmedUntil) {
        stopArmedUntil = Date.now() + STOP_ARM_MS;
        els.stopBtn.textContent = 'Подтвердить';

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
    els.stopBtn.textContent = 'Останавливаем…';

    fetchJson('stop_analysis')
        .then((res) => {
            if (!res) {
                resetStopBtn();
                appendLog({ time: '--:--:--', type: 'error', message: 'Сервер не ответил на запрос остановки.' });
            } else if (res.status === 'ok') {
                // Дальше финал придёт опросом: он и сбросит кнопку.
            } else if (res.status === 'idle') {
                // Демон уже не работает: останавливать нечего. Честно говорим
                // об этом и синхронизируем UI с фактическим состоянием.
                resetStopBtn();
                appendLog({ time: '--:--:--', type: 'warning', message: res.message || 'Обработка уже не выполняется — останавливать нечего.' });
                refreshInbox();
            } else {
                resetStopBtn();
                appendLog({ time: '--:--:--', type: 'error', message: res.message || 'Не удалось отправить запрос остановки.' });
            }
        })
        .catch(() => {
            resetStopBtn();
            appendLog({ time: '--:--:--', type: 'error', message: 'Нет связи с сервером — запрос остановки не отправлен.' });
        });
}

// ---------- Опрос состояния ----------

// Синхронизируем кэш строк с тем, что уже сообщил демон. Иначе сортировка
// или перерисовка таблицы снова показали бы «В очереди…» у готового трека.
// Объект общий: ref.row в rowRefs — это тот же элемент state.rows.
function markRow(name, patch) {
    const row = state.rows.find((r) => r.name === name);
    if (row) Object.assign(row, patch);
}

function startPolling(launchAnalysis) {
    stopPolling();
    state.mode = 'poll';
    // Демон поднимается отдельным процессом, поэтому progress.json ещё
    // какое-то время отдаёт остаток ПРЕДЫДУЩЕГО прогона (status 'complete').
    // Раньше такой остаток принимался за финал только что запущенного прогона:
    // опрос останавливался, страница писала «Готово», кнопка «Обработать»
    // снова становилась активной — а демон между тем работал, и в списке
    // треков он снова был «в очереди». Приходилось жать кнопку ещё раз.
    // Теперь до первого 'running' терминальные статусы просто игнорируются.
    state.awaitingRun = true;
    state.launchedAt = Date.now();
    els.stopBtn.hidden = false;
    updateProcessUI();
    syncPlayButtons();
    syncDeleteButtons();

    if (launchAnalysis) {
        fetchJson('start_analysis').then((res) => {
            if (!res) return;
            if (res.status === 'already_running') {
                appendLog({ time: '--:--:--', type: 'warning', message: res.message || 'Анализ уже выполняется.' });
            } else if (res.status === 'blocked') {
                appendLog({ time: '--:--:--', type: 'error', message: res.message || 'Сейчас выполняется генерация стемов.' });
                finishProcessing();
            } else if (res.status === 'idle') {
                appendLog({ time: '--:--:--', type: 'warning', message: res.message || 'Нет файлов для обработки.' });
                finishProcessing();
            } else if (res.status === 'error') {
                appendLog({ time: '--:--:--', type: 'error', message: 'Не удалось запустить обработку.' });
                finishProcessing();
            }
        }).catch(() => {});
    }

    state.pollTimer = setInterval(pollProgress, POLL_INTERVAL);
    pollProgress();
}

function stopPolling() {
    if (state.pollTimer !== null) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
    }
}

function pollProgress() {
    fetchJson('get_progress')
        .then((progress) => {
            if (progress.stemgen_running !== undefined) {
                state.stemgenRunning = !!progress.stemgen_running;
            }

            const status = progress.status || 'idle';

            // Демон ещё не проснулся — терминальный статус не наш. Молча ждём
            // 'running' и не трогаем журнал: иначе на экране мелькнёт зелёное
            // «Готово» от старого прогона.
            if (state.awaitingRun && status !== 'running') {
                if (Date.now() - state.launchedAt > LAUNCH_WAIT_MS) {
                    state.awaitingRun = false;
                    appendLog({
                        time: '--:--:--',
                        type: 'error',
                        message: 'Демон не начал прогон за ' + Math.round(LAUNCH_WAIT_MS / 1000) + ' с — состояние сброшено, запустите заново.',
                    });
                    finishProcessing();
                    refreshInbox();
                }
                return;
            }

            if (status === 'running') {
                state.awaitingRun = false;
            }

            updateProcessUI();

            if (status === 'running') {
                if (isStaleRun(progress)) {
                    recoverDeadRun();
                    return;
                }
                state.sawRun = true;

                // Живой журнал прогона — единственная текстовая подпись под
                // прогрессбаром. Терминальные last_message («Готово: обработано
                // 3 из 3 файлов.», «Остановлено: обработано…») сюда НЕ идут:
                // это итог прошлого прогона, который держался в тулбаре часами
                // и врал, будто работа идёт. Итог показываем один раз, когда
                // прогон реально дошёл до конца, — см. logRunFinished ниже.
                renderLogs(progress.last_message);

                // Готовность треков сообщает демон (progress.done_files /
                // progress.error_files) — по ходу прогона, с результатом.
                // Раньше doneSet собирался из кэша state.rows, который
                // обновлялся только в финале (refreshInbox), поэтому уже
                // обработанные треки откатывались в «В очереди…» и висели
                // так до самого конца.
                const doneRun = progress.done_files || {};
                const errRun  = progress.error_files || {};

                // Готовые ДО этого прогона (в done_files их нет — список
                // сбрасывается на каждый запуск).
                const doneSet = new Set(
                    state.rows.filter((r) => (r.status || '') === 'done').map((r) => r.name)
                );
                const cur = progress.current_file;
                const stageIndex = progress.current_stage_index;
                const stageLabel = progress.current_stage_label;

                state.rowRefs.forEach((ref, name) => {
                    if (name === cur) {
                        // Этап из демона рисуем в строке сразу: полоска растёт
                        // по факту выполненного шага, а не по таймеру.
                        rowProcessing(name, stageIndex, stageLabel);
                    } else if (errRun[name]) {
                        rowError(name, errRun[name]);
                        markRow(name, { status: 'error', message: errRun[name] });
                    } else if (doneRun[name]) {
                        rowDone(name, doneRun[name]);
                        markRow(name, {
                            status: 'done',
                            bpm: doneRun[name].bpm,
                            key: doneRun[name].key,
                            duration: doneRun[name].duration,
                        });
                    } else if (!doneSet.has(name)) {
                        rowQueued(name);
                    }
                });
                return;
            }

            // Run исчез: статус стал idle, хотя мы уже видели running (демон умер,
            // storage очистили, статус сброшен) — выходим из «зависшей» фазы,
            // чтобы не мерцало «Идёт обработка» и не висела полоса.
            if (status === 'idle' && state.sawRun) {
                recoverDeadRun();
                return;
            }

            if (TERMINAL_STATES.has(status)) {
                stopPolling();
                state.mode = 'done';
                // Кнопку «Стоп» сбрасываем здесь же: путь финала опроса не
                // проходит через finishProcessing(), из-за чего state.stopping
                // оставался true и следующая кнопка не реагировала.
                resetStopBtn();
                updateProcessUI();
                // Итог прогона. Индикатор статуса в шапке удалён, и раньше он
                // был единственным местом, где пользователь узнавал о финале:
                // строка молчала намеренно, чтобы не висеть зелёной «Готово»
                // спустя минуты после конца. Теперь показываем итог ОДИН раз
                // и на LOG_FINAL_MS, сообщением демона из last_message.
                // Остановку не дублируем: пользователь инициировал её сам.
                if (status === 'stopped') {
                    logRunFinished(null, 'Остановлено');
                } else {
                    logRunFinished(progress.last_message, 'Готово');
                }
                refreshInbox();
            }
        })
        .catch(() => {
            stopPolling();
            state.mode = 'idle';
            resetStopBtn();
            updateProcessUI();
        });
}

export { startProcessing, requestStop, startPolling, resetStopBtn };