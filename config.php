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

// Модель Demucs. htdemucs даёт 4 стема: vocals, drums, bass, other.
define('STEMGEN_DEMUCS_MODEL', getenv('STEMGEN_DEMUCS_MODEL') ?: 'htdemucs');

// Имена стемов в порядке выхода демоуксика (без "no_vocals", which появляется при --two-stems).
define('STEMGEN_STEMS', ['vocals', 'drums', 'bass', 'other']);

// Бигрейт MP3-стемов.
define('STEMGEN_MP3_BITRATE', 320);

// Удалять исходный MP3 из music/sorted/ после успешного разделения.
define('STEMGEN_DELETE_SOURCE', true);

// Файл прогресса модуля «Стемы» (отдельно от анализа).
define('STEMGEN_PROGRESS_FILE', __DIR__ . '/storage/stemgen_progress.json');

if (STEMPLAYER_MAX_EXEC_TIME > 0) {
    set_time_limit(STEMPLAYER_MAX_EXEC_TIME);
}