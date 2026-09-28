<?php

declare(strict_types=1);

/**
 * Запуск фонового процесса (CLI) в отрыве от HTTP-запроса.
 *
 * Идея «независимой страницы»: скорость обработки и результат не должны
 * зависеть от того, открыт ли сейчас браузер. Работу выполняет отдельный
 * php-процесс, а страницы лишь опрашивают progress-файл.
 *
 * Важно про путь к PHP: под Apache константа PHP_BINARY указывает на
 * httpd.exe, а PHP_BINDIR — на несуществующий каталог. Поэтому интерпретатор
 * берётся из STEMPLAYER_PHP (config.php) и никогда не из PHP_BINARY.
 */
final class SpawnCli
{
    /**
     * @param string      $script    Полный путь к cli-скрипту модуля.
     * @param string|null $stdoutLog Файл для stdout/stderr демона. Обязателен по
     *                                сути: без него фатал внутри демона невидим.
     *
     * @return array{ok: bool, error?: string, log?: string}
     */
    public static function spawn(string $script, ?string $stdoutLog = null): array
    {
        $resolved = realpath($script);

        if ($resolved === false || !is_file($resolved)) {
            return ['ok' => false, 'error' => 'CLI-скрипт не найден: ' . $script];
        }

        $php = self::phpBinary();
        $log = ($stdoutLog !== null && $stdoutLog !== '')
            ? $stdoutLog
            : dirname(__DIR__) . '/logs/spawn.log';

        $logDir = dirname($log);

        if (!is_dir($logDir) && !@mkdir($logDir, 0777, true) && !is_dir($logDir)) {
            return ['ok' => false, 'error' => 'Не удалось создать каталог лога: ' . $logDir];
        }

        $root = dirname(__DIR__);

        if (PHP_OS_FAMILY !== 'Windows') {
            $cmd = 'cd ' . escapeshellarg($root) . ' && ' . escapeshellarg($php) . ' '
                . escapeshellarg($resolved) . ' > ' . escapeshellarg($log) . ' 2>&1 &';

            $handle = @popen($cmd, 'r');

            if ($handle === false) {
                return ['ok' => false, 'error' => 'Не удалось запустить фоновый процесс'];
            }

            pclose($handle);

            return ['ok' => true, 'log' => $log];
        }

        // Windows: прямой запуск php.exe в обход cmd. Конструкция `start /B`
        // под Apache не работает — дочерний процесс не стартует. Вывод демона
        // уходит в файлы, окно консоли не создаётся.
        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['file', $log, 'w'],
            2 => ['file', $log . '.err', 'w'],
        ];

        $pipes = [];
        $process = @proc_open(
            [$php, $resolved],
            $descriptors,
            $pipes,
            $root,
            null,
            ['bypass_shell' => true]
        );

        if (!is_resource($process)) {
            return ['ok' => false, 'error' => 'Не удалось запустить фоновый процесс (proc_open)'];
        }

        fclose($pipes[0]);

        // proc_close() ждёт завершения демона — нельзя, он живёт дольше запроса.
        // Хендл освободится вместе со скриптом, потомок продолжает работу.
        return ['ok' => true, 'log' => $log];
    }

    /**
     * Хвост лога запуска для показа в UI, если демон не подал признаков жизни.
     * Возвращает всегда валидный UTF-8 (вывод внешних программ бывает в
     * windows-1251, а json_encode на таком падает).
     */
    public static function logTail(?string $log, int $lines = 8): string
    {
        if ($log === null || !is_file($log)) {
            return '';
        }

        $raw = @file($log, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);

        if ($raw === false || $raw === []) {
            return '';
        }

        $err = $log . '.err';

        if (is_file($err)) {
            $extra = @file($err, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);

            if (is_array($extra)) {
                $raw = array_merge($raw, $extra);
            }
        }

        $text = trim(implode(' | ', array_slice($raw, -$lines)));

        if (function_exists('mb_check_encoding') && !mb_check_encoding($text, 'UTF-8')) {
            $converted = @mb_convert_encoding($text, 'UTF-8', 'Windows-1251');
            $text = is_string($converted) ? $converted : (preg_replace('/[^\x09\x0A\x0D\x20-\x7E]/', '?', $text) ?? '');
        }

        return $text;
    }

    private static function phpBinary(): string
    {
        $candidates = [];

        if (defined('STEMPLAYER_PHP')) {
            $candidates[] = (string) STEMPLAYER_PHP;
        }

        if (defined('PHP_BINDIR') && PHP_BINDIR !== '') {
            $candidates[] = rtrim((string) PHP_BINDIR, '/\\') . '/php.exe';
        }

        if (defined('PHP_BINARY') && PHP_BINARY !== '') {
            $candidates[] = (string) PHP_BINARY;
            $candidates[] = dirname((string) PHP_BINARY) . '/php.exe';
        }

        foreach ($candidates as $candidate) {
            // Под Apache PHP_BINARY = httpd.exe — такой кандидат пропускаем.
            if (PHP_OS_FAMILY === 'Windows' && !preg_match('/php\.exe$/i', $candidate)) {
                continue;
            }

            if (is_file($candidate)) {
                return $candidate;
            }
        }

        return PHP_OS_FAMILY === 'Windows' ? 'php.exe' : 'php';
    }
}