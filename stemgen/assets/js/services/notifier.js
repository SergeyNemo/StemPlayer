'use strict';
(function (G) {
    const { els } = G;

    // Бейдж статуса - общий код (StemUI.createBadge), тот же, что на
    // странице «Обработка»: complete/error держим 3 секунды и тихо гасим
    // в idle, иначе надпись «complete» висит вечно.
    G.setBadge = window.StemUI.createBadge(els.statusBadge);


    // Индикатор работы демона без процентов: полоса ездит туда-сюда и сообщает
    // только «идёт генерация». Долей прогресса нет ни на диске, ни в UI.
    G.showProgress = function showProgress(running) {
        if (!els.overallProgress || !els.progressBar) return;
        els.overallProgress.hidden = !running;
        els.progressBar.classList.toggle('is-active', !!running);
    };

    // Это «журнал» — одна строка под прогрессбаром. Поведение живёт в общем
    // ядре (StemUI.createLogLine), ровно как на странице «Обработка»: новая
    // запись сменяет старую, а без новых строка сама исчезает через
    // LOG_LIFE_MS. Раньше строка жила до следующего события — из-за этого на
    // экране навсегда оставались «Загружено файлов: 1» и прочие сообщения
    // о давних событиях. Подписи типа («OK», «ИНФО») в строке нет: тип виден
    // по цвету, а сверху есть бейдж статуса.
    const logLine = window.StemUI.createLogLine(els.logLine);

    G.appendLog = function appendLog(msg) {
        logLine.append(String((msg && msg.type) || 'info').toLowerCase(), (msg && msg.message) || '');
    };

    G.hideLogLine = function hideLogLine() {
        logLine.hide();
    };

    // Живая строка журнала: демон пишет в progress.json единственное поле
    // last_message, polling подхватывает его и показывает, пока не придёт новое.
    let lastShownMessageKey = null;

    G.renderLogs = function renderLogs(entry) {
        if (!entry || !entry.message) return;
        const key = `${entry.time}|${entry.type}|${entry.message}`;
        if (key === lastShownMessageKey) return;
        lastShownMessageKey = key;
        G.appendLog(entry);
    };

    let bannerTimer = null;

    // Плавно показываем баннер, через 3 секунды плавно прячем.
    G.showBanner = function showBanner(text) {
        if (bannerTimer) {
            clearTimeout(bannerTimer);
            bannerTimer = null;
        }

        els.banner.textContent = '';
        const span = document.createElement('span');
        span.textContent = text;
        els.banner.appendChild(span);
        els.banner.hidden = false;

        // Переход display:none -> flex нельзя анимировать сразу, ждём следующий кадр.
        requestAnimationFrame(() => requestAnimationFrame(() => els.banner.classList.add('is-visible')));

        bannerTimer = setTimeout(() => G.hideBanner(), 3000);
    };

    G.hideBanner = function hideBanner() {
        if (bannerTimer) {
            clearTimeout(bannerTimer);
            bannerTimer = null;
        }
        els.banner.classList.remove('is-visible');
        setTimeout(() => {
            if (!els.banner.classList.contains('is-visible')) {
                els.banner.hidden = true;
                els.banner.textContent = '';
            }
        }, 350);
    };
})(window.StemGen);