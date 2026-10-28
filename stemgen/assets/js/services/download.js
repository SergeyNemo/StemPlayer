'use strict';
(function (G) {
    // Сохранение отдельного стема на диск через File System Access API
    // (Chromium) с фолбэком на <a download> (Firefox / Safari).
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

        // Диалог открываем синхронно до сетевого запроса для сохранения
        // контекста user gesture (transient activation).
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
            // AbortError — отмена, не ошибка.
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
