'use strict';
(function (G) {
    // Сохранение одного стема на диск пользователя.
    //
    // Почему без PHP: стем уже лежит по статическому пути (StemRegistry::stemUrl
    // отдаёт относительный ../music/sorted/…) и браузер его уже качает целиком
    // для декодирования (Stem.load). Значит, чтобы отдать файл с нужным именем,
    // достаточно забрать те же байты и записать их через File System Access API.
    // Серверный экшен с Content-Disposition дал бы то же самое, но добавил бы в
    // проект роутинг, файл-стример и проверку путей ради одной кнопки. Имя файла
    // при этом задаёт клиент — а оно зависит от названия трека, которое клиент
    // же и держит на экране.
    //
    // Почему showSaveFilePicker, а не <a download>: у anchor нет обратной связи
    // от диалога. Браузер показывает «Сохранить как» и молчит — отменил
    // пользователь или подтвердил, мы узнаём только по факту нажатия. Журнал
    // писал «Сохранено: …» сразу после click, то есть врал на каждом отмене
    // (а это половина открытий, и именно их видишь как «ничего не сохранилось»).
    // showSaveFilePicker — тот же диалог, но он РЕШАЕТСЯ по факту сохранения:
    // fulfilled → файл записан, AbortError → пользователь нажал «Отмена».
    // Имя файла уходит в suggestedName, поэтому диалог сразу показывает
    // «Artist - Song_vocal.mp3», а не выдуманное браузером имя.
    //
    // showSaveFilePicker есть только в Chromium (secure context) — Firefox и
    // Safari им не поддерживают. Там остаётся anchor с download, и журнал
    // честно пишет «Файл передан в загрузки», а не «Сохранено»: подтвердить
    // запись без API нечем, и врать не нужно.
    G.downloadStem = async function downloadStem(stem, trackName) {
        const fileName = G.stemFileName(trackName, stem && stem.kind);
        const kindName = (stem && G.STEM_NAMES[stem.kind]) || 'стем';

        if (!stem || !stem.hasAudio) {
            G.appendLog({
                time: '--:--:--',
                type: 'warning',
                message: `У трека нет файла «${kindName}» — сохранять нечего`,
            });
            return null;
        }

        // Диалог открываем ДО сетевого запроса: pick() требует живого жеста
        // пользователя (transient activation), который теряется после await.
        // Побочный плюс — пользователь может отменить, не дожидаясь загрузки.
        if (typeof window.showSaveFilePicker === 'function') {
            return saveThroughPicker(stem, fileName);
        }

        return saveThroughAnchor(stem, fileName);
    };

    // Основной путь: диалог с выбором папки, запись через FileSystemWritableFileStream.
    async function saveThroughPicker(stem, fileName) {
        let handle = null;

        try {
            handle = await window.showSaveFilePicker({
                suggestedName: fileName,
                types: [{ description: 'MP3', accept: { 'audio/mpeg': ['.mp3'] } }],
            });
        } catch (err) {
            // AbortError — штатная отмена, не ошибка. Молча уходим: пользователь
            // сам сказал «не надо», журнал об этом сообщать незачем.
            if (err && err.name === 'AbortError') return null;
            G.appendLog({
                time: '--:--:--',
                type: 'error',
                message: `Не открылся диалог сохранения: ${(err && err.message) || err}`,
            });
            return null;
        }

        try {
            const res = await fetch(stem.url, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const writable = await handle.createWritable();
            await writable.write(await res.blob());
            await writable.close();

            // Точка единственная, где «сохранено» правда: writable.close()
            // завершился, значит файл действительно записан на диск.
            G.appendLog({ time: '--:--:--', type: 'info', message: `Сохранено: ${fileName}` });
            return fileName;
        } catch (err) {
            G.appendLog({
                time: '--:--:--',
                type: 'error',
                message: `Не удалось сохранить ${fileName}: ${(err && err.message) || err}`,
            });
            return null;
        }
    }

    // Запасной путь для браузеров без File System Access API: anchor с
    // download. Обратной связи от диалога нет, поэтому журнал не утверждает,
    // что файл сохранён, — только что он передан браузеру.
    async function saveThroughAnchor(stem, fileName) {
        let objectUrl = '';

        try {
            const res = await fetch(stem.url, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            objectUrl = URL.createObjectURL(await res.blob());

            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = fileName; // ровно то имя, о котором мы сообщаем в UI
            a.rel = 'noopener';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();

            // blob живёт в памяти до revoke, а стем на 5 минут — это десятки
            // мегабайт на каждый стем. Скачивание к этому моменту уже началось
            // (браузер держит свой файловый дескриптор), но revoke сразу после
            // click иногда обрывает запись — отпускаем blob с запасом.
            setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);

            G.appendLog({ time: '--:--:--', type: 'info', message: `Файл передан в загрузки: ${fileName}` });
            return fileName;
        } catch (err) {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            G.appendLog({
                time: '--:--:--',
                type: 'error',
                message: `Не удалось сохранить ${fileName}: ${(err && err.message) || err}`,
            });
            return null;
        }
    }
})(window.StemGen);
