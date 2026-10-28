<?php

declare(strict_types=1);

/**
 * Глобальная конфигурация StemPlayer.
 */

// Исполняемый файл Python. Можно переопределить переменной окружения
// STEMPLAYER_PYTHON (например, полный путь к python.exe).
define('STEMPLAYER_PYTHON', getenv('STEMPLAYER_PYTHON') ?: 'python');

// PHP-интерпретатор для запуска CLI-демонов. Под Apache константы PHP_BINARY /
// PHP_BINDIR указывают на httpd.exe и несуществующий C:\php, поэтому путь к
// php.exe задаётся явно (переопределяется переменной STEMPLAYER_PHP).
define('STEMPLAYER_PHP', getenv('STEMPLAYER_PHP') ?: 'C:/xampp/php/php.exe');

// Максимальное время выполнения long-running операций (сек). 0 = без ограничения.
define('STEMPLAYER_MAX_EXEC_TIME', 0);

// Расширения, которые считаем аудиофайлами.
define('STEMPLAYER_AUDIO_EXT', ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma', 'aiff', 'aif']);

// Файл состояния модуля «Обработка» (analysis).
define('ANALYSIS_PROGRESS_FILE', __DIR__ . '/storage/progress.json');

// URL страниц модулей (используется взаимной блокировкой страниц).
define('STEMPLAYER_ANALYSIS_PAGE', 'analysis/index.php');
define('STEMPLAYER_STEMGEN_PAGE', 'stemgen/index.php');

// --- Модуль «Стемы» (stemgen) ---

// Python из виртуального окружения venv_demucs (там torch+CUDA и demucs).
// Если не задан — используется STEMPLAYER_PYTHON.
define('STEMGEN_PYTHON', getenv('STEMGEN_PYTHON') ?: (__DIR__ . '/venv_demucs/Scripts/python.exe'));

// Модель Demucs. htdemucs_ft (fine-tuned) даёт те же 4 стема: vocals, drums,
// bass, other, но чище разделяет низы (bass/drums). Это ансамбль из 4
// дообученных моделей, они гонятся по очереди — медленнее, но точнее.
define('STEMGEN_DEMUCS_MODEL', getenv('STEMGEN_DEMUCS_MODEL') ?: 'htdemucs_ft');

// Имена стемов в порядке выхода демоуксика (без "no_vocals", which появляется при --two-stems).
define('STEMGEN_STEMS', ['vocals', 'drums', 'bass', 'other']);

// Бигрейт MP3-стемов.
define('STEMGEN_MP3_BITRATE', 320);

// Удалять исходный MP3 из music/sorted/ после успешного разделения.
define('STEMGEN_DELETE_SOURCE', true);

// Файл прогресса модуля «Стемы» (отдельно от анализа).
define('STEMGEN_PROGRESS_FILE', __DIR__ . '/storage/stemgen_progress.json');

// --- Каскадное разделение стема (Other → guitar/piano) ---

// Модель второго прохода. htdemucs_6s — единственная модель Demucs, которая
// отдаёт гитару и пиано отдельными стемами (4 базовых + guitar + piano).
define('STEMGEN_CASCADE_MODEL', getenv('STEMGEN_CASCADE_MODEL') ?: 'htdemucs_6s');

// Качество второго прохода (флаги Demucs, п.1): TTA-усреднение --shifts и
// перекрытие сегментов --overlap. Больше значение — чище, но кратно дольше
// (shifts множит время прогона). По умолчанию 3 / 0.5.
define('STEMGEN_CASCADE_SHIFTS', getenv('STEMGEN_CASCADE_SHIFTS') ?: '3');
define('STEMGEN_CASCADE_OVERLAP', getenv('STEMGEN_CASCADE_OVERLAP') ?: '0.5');

// Исходный стем каскада (в интерфейсе подписан как Other) и то, что из него
// достаём. Порядок совпадает с ProgressStore::STEMGEN_CASCADE_STAGES и с
// CASCADE_STEMS в split_instrument.py.
define('STEMGEN_CASCADE_SOURCE_STEM', 'other');
define('STEMGEN_CASCADE_STEMS', ['guitar', 'piano']);

// Файл-дескриптор запроса каскада: пишет API, читает и удаляет демон.
// Демон запускается без аргументов (SpawnCli), поэтому «что делить» он
// узнаёт из этого файла, как и принято в модуле (работа с диска).
define('STEMGEN_CASCADE_REQUEST_FILE', __DIR__ . '/storage/cascade_request.json');

if (STEMPLAYER_MAX_EXEC_TIME > 0) {
    set_time_limit(STEMPLAYER_MAX_EXEC_TIME);
}

// Автозагрузка классов ядра и модулей (core/, analysis/classes/, stemgen/classes/)
spl_autoload_register(static function (string $class): void {
    static $dirs = [
        __DIR__ . '/core/',
        __DIR__ . '/analysis/classes/',
        __DIR__ . '/stemgen/classes/',
    ];

    $file = str_replace('\\', '/', $class) . '.php';

    foreach ($dirs as $dir) {
        $path = $dir . $file;
        if (is_file($path)) {
            require_once $path;
            return;
        }
    }
});