<?php

declare(strict_types=1);

/**
 * Глобальная конфигурация StemPlayer.
 */

// Исполняемый файл Python. Можно переопределить переменной окружения
// STEMPLAYER_PYTHON (например, полный путь к python.exe).
define('STEMPLAYER_PYTHON', getenv('STEMPLAYER_PYTHON') ?: 'python');

// Максимальное время выполнения long-running операций (сек). 0 = без ограничения.
define('STEMPLAYER_MAX_EXEC_TIME', 0);

// Расширения, которые считаем аудиофайлами.
define('STEMPLAYER_AUDIO_EXT', ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma', 'aiff', 'aif']);

if (STEMPLAYER_MAX_EXEC_TIME > 0) {
    set_time_limit(STEMPLAYER_MAX_EXEC_TIME);
}