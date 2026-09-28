'use strict';
(function (G) {
    const { els } = G;
    const TYPE_LABELS = G.TYPE_LABELS;

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

    let logSwapTimer = null;
    let lastShownMessageKey = null;

    // Это «журнал» теперь — одна строка под прогрессбаром. Видна постоянно,
    // пока не придёт новая запись: старая плавно гаснет, новая плавно появляется.
    function buildLogLine(type, message) {
        els.logLine.className = `log-line log-${type}`;
        els.logLine.innerHTML = '';

        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = TYPE_LABELS[type] || String(type).toUpperCase();

        const text = document.createElement('span');
        text.className = 'message';
        text.textContent = message;

        els.logLine.append(badge, text);
        els.logLine.hidden = false;

        requestAnimationFrame(() => requestAnimationFrame(() => els.logLine.classList.add('is-show')));
    }

    G.appendLog = function appendLog(msg) {
        if (!els.logLine) return;
        if (logSwapTimer) {
            clearTimeout(logSwapTimer);
            logSwapTimer = null;
        }

        const type = (msg.type || 'info').toLowerCase();

        if (!els.logLine.hidden && els.logLine.classList.contains('is-show')) {
            els.logLine.classList.remove('is-show');
            logSwapTimer = setTimeout(() => buildLogLine(type, msg.message || ''), 200);
        } else {
            buildLogLine(type, msg.message || '');
        }
    };

    G.hideLogLine = function hideLogLine() {
        els.logLine.classList.remove('is-show');
        setTimeout(() => {
            if (!els.logLine.classList.contains('is-show')) els.logLine.hidden = true;
        }, 300);
    };

    // Живая строка журнала: демон пишет в progress.json единственное поле
    // last_message, polling подхватывает его и показывает, пока не придёт новое.
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