<?php

declare(strict_types=1);

/**
 * Запуск внешнего python-скрипта через proc_open.
 *
 * Скрипт может писать в stdout служебные строки прогресса
 * ({"stage":"bpm"}) — они разбираются построчно и уходят в $onStage,
 * а последняя строка с "status" считается результатом. Дополнительных
 * файлов прогресса и опросов нет: этапы приезжают в тот момент,
 * когда реально случились.
 *
 * Чтение stdout идёт через временный ФАЙЛ, а не конвейер. Особенности
 * Windows/PHP 8.2, из-за которых реализация неочевидна (проверено на
 * месте, а не из догадок):
 *
 *  1. stream_set_blocking(false) на конвейерах proc_open НЕ работает
 *     (возвращает false) — fread() пустого канала блокирует до прихода
 *     данных, сколько бы ни подождал.
 *  2. stream_select() на конвейере врёт: возвращает «готов» мгновенно
 *     (ready=1, dt≈0ms) даже когда данных нет вообще. Значит им нельзя
 *     отгораживаться от блокирующего fread().
 *
 * Из-за этого старый цикл с конвейером замирал на «молчаливых» минутах
 * (демucs не пишет в stdout): fread() висел до следующей строки, и
 * keepAlive()/остановка не вызывались — last_ping в progress-файле
 * замирал, и страница после 120 секунд объявляла живой процесс
 * зависшим. Файл читается без блокировки в любом состоянии, поэтому
 * цикл каждые ~100 мс дочитывает вывод и качает сердцебиение.
 */
final class PythonRunner
{
    /**
     * @param callable(): bool|null       $stopCheck Вернуть true — прервать процесс.
     * @param callable(string): void|null $onStage   Колбэк на каждую распознанную
     *                                               служебную строку {"stage": "..."}.
     * @param string                      $python    Полный путь к интерпретатору.
     *                                               Пустая строка — STEMPLAYER_PYTHON.
     *
     * @return array{
     *   stdout: string,
     *   stderr: string,
     *   exit_code: int,
     *   terminated: bool
     * }
     */
    public function run(string $script, array $cliArgs = [], ?callable $stopCheck = null, string $python = '', ?callable $onStage = null): array
    {
        $interpreter = $python !== '' ? $python : STEMPLAYER_PYTHON;
        $command = [$interpreter, $script, ...$cliArgs];

        // Вывод — во временные файлы. stderr уходил в файл и раньше (см.
        // старые комментарии выше), stdout переносим тоже: единственный
        // способ не блокироваться на пустом канале.
        $stderrFile = tempnam(sys_get_temp_dir(), 'stempy_');
        $stdoutFile = tempnam(sys_get_temp_dir(), 'stempy_out_');

        $descriptors = [
            0 => ['pipe', 'r'],
            1 => $stdoutFile !== false ? ['file', $stdoutFile, 'w'] : ['pipe', 'w'],
            2 => $stderrFile !== false ? ['file', $stderrFile, 'w'] : ['pipe', 'w'],
        ];

        // env не передаём: вместе с $_SERVER на Windows PHP искажает окружение
        // дочернего процесса (python не находится), поэтому наследуем его как есть.
        $process = proc_open($command, $descriptors, $pipes, dirname(__DIR__));

        if (!is_resource($process)) {
            $this->removeTempFile($stderrFile);
            $this->removeTempFile($stdoutFile);

            return [
                'stdout'     => '',
                'stderr'     => 'Не удалось запустить python (' . $interpreter . '). Проверьте config.php.',
                'exit_code'  => -1,
                'terminated' => false,
            ];
        }

        fclose($pipes[0]);

        $stream = ($stdoutFile !== false) ? @fopen($stdoutFile, 'r') : false;

        $offset    = 0;
        $stdout    = '';
        $stageBuf  = '';
        $stopped   = false;
        $pid       = 0;
        $lastGrow  = microtime(true);
        $deadSince = 0.0;
        $aliveCheckedAt = 0.0;

        // Страховка от патологического случая, когда процесс числится «мёртвым»
        // (running=false), PID не подтверждается, но файл не растёт бесконечно.
        $graceDeadline = 600.0;

        try {
            while (true) {
                // Сердцебиение и стоп — на КАЖДОЙ итерации, а не только при
                // $running: на этой сборке Windows/PHP proc_get_status()['running']
                // отдаёт false на живом, но молчащем процессе. Короткое
                // замыкание в `if ($running && $stopCheck())` оставляло keepAlive
                // невызванным (last_ping замирал, страница писала «завис») и
                // стоп мёртвым. keepAlive сам дешёвый (запись не чаще раза в
                // 10 с), поэтому вызов вне условия бесплатен.
                if ($stopCheck !== null && $stopCheck()) {
                    $this->terminate($process);
                    $stopped = true;
                    break;
                }

                $status = proc_get_status($process);

                if ($pid === 0) {
                    $pid = (int) ($status['pid'] ?? 0);
                }

                // Дочитываем stdout: сколько появилось нового — столько и берём.
                if ($stream !== false) {
                    clearstatcache(true, $stdoutFile);
                    $size = @filesize($stdoutFile);

                    if ($size !== false && $size > $offset) {
                        $chunk = (string) @fread($stream, $size - $offset);

                        if ($chunk !== '') {
                            $offset   += strlen($chunk);
                            $lastGrow  = microtime(true);
                            $stdout   .= $chunk;
                            $stageBuf .= $chunk;
                            $this->consumeLines($stageBuf, $onStage);
                        }
                    }
                }

                $running = (bool) ($status['running'] ?? false);

                if ($running) {
                    $deadSince = 0.0;
                    $aliveCheckedAt = 0.0;
                } elseif ($deadSince === 0.0) {
                    $deadSince = microtime(true);
                } elseif (microtime(true) - $deadSince > $graceDeadline) {
                    break;
                } elseif (microtime(true) - $lastGrow >= 0.7) {
                    // Файл не растёт — присматриваемся. Правду о «мёртвости»
                    // уточняем не чаще раза в секунду: tasklist стоит дорого.
                    if (microtime(true) - $aliveCheckedAt >= 1.0) {
                        $aliveCheckedAt = microtime(true);

                        if (!$this->processAlive($pid)) {
                            break;
                        }
                    }
                }

                usleep(100_000);
            }
        } finally {
            // Добираем остаток stdout (прогресс-строки, финальная status).
            if ($stream !== false) {
                clearstatcache(true, $stdoutFile);
                $size = @filesize($stdoutFile);

                if ($size !== false && $size > $offset) {
                    $chunk = (string) @fread($stream, $size - $offset);

                    if ($chunk !== '') {
                        $stdout   .= $chunk;
                        $stageBuf .= $chunk;
                        $this->consumeLines($stageBuf, $onStage);
                    }
                }

                fclose($stream);
            }

            if (isset($pipes[2]) && is_resource($pipes[2])) {
                fclose($pipes[2]);
            }
        }

        $exitCode = proc_close($process);
        $stderr   = $this->readTempFile($stderrFile);
        $this->removeTempFile($stderrFile);
        $this->removeTempFile($stdoutFile);

        return [
            'stdout'     => $stdout,
            'stderr'     => $stderr,
            'exit_code'  => $exitCode,
            'terminated' => $stopped,
        ];
    }

    /**
     * Разбор одной строки stdout.
     *
     * Служебная строка {"stage":"bpm"} уходит в $onStage, строка с полем
     * "status" — это и есть результат анализа. Остальное игнорируем,
     * чтобы случайный мусор не ломал разбор.
     *
     * @param callable(string): void|null $onStage
     */
    private function handleLine(string $line, ?callable $onStage): void
    {
        if ($line === '') {
            return;
        }

        $decoded = json_decode($line, true);

        if (!is_array($decoded)) {
            return;
        }

        if (isset($decoded['stage']) && is_string($decoded['stage']) && !isset($decoded['status'])) {
            if ($onStage !== null) {
                $onStage($decoded['stage']);
            }
        }
    }

    /**
     * Разбор накопленного буфера построчно, пока в нём есть переводы строк.
     *
     * Остаток без "\n" остаётся в $stageBuf и ждёт следующего чанка —
     * строка могла прибыть не целой (чтение из файла не гарантирует границ).
     */
    private function consumeLines(string &$stageBuf, ?callable $onStage): void
    {
        while (($nl = strpos($stageBuf, "\n")) !== false) {
            $line     = substr($stageBuf, 0, $nl);
            $stageBuf = substr($stageBuf, $nl + 1);
            $this->handleLine(trim($line), $onStage);
        }
    }

    /**
     * Жив ли процесс на самом деле.
     *
     * На Windows proc_get_status()['running'] лжёт на живом молчащем
     * процессе (проверено), поэтому «мёртвость» подтверждаем через tasklist.
     * На *nix running достоверен: false — процесс умер.
     */
    private function processAlive(int $pid): bool
    {
        if (DIRECTORY_SEPARATOR !== '\\') {
            // *nix: proc_get_status()['running'] не врёт — вызывающий уже
            // видел running=false, значит процесс закончился.
            return false;
        }

        if ($pid <= 0) {
            // PID не достали — консервативно считаем живым, чтобы не
            // оборвать работающую стадию из-за ложного running=false.
            return true;
        }

        @exec('tasklist /FI "PID eq ' . $pid . '" /NH 2>NUL', $lines, $rc);

        foreach ((array) $lines as $line) {
            if (preg_match('/\b' . preg_quote((string) $pid, '/') . '\b/', $line)) {
                return true;
            }
        }

        return false;
    }

    private function readTempFile($file): string
    {
        if ($file === false || !is_file($file)) {
            return '';
        }

        return trim((string) @file_get_contents($file));
    }

    private function removeTempFile($file): void
    {
        if ($file !== false && is_file($file)) {
            @unlink($file);
        }
    }

    /**
     * Принудительно завершает python-процесс и его дочерние (ffmpeg и т.п.).
     */
    private function terminate($process): void
    {
        $status = proc_get_status($process);
        $pid    = (int) ($status['pid'] ?? 0);

        if (DIRECTORY_SEPARATOR === '\\' && $pid > 0) {
            @exec('taskkill /PID ' . $pid . ' /T /F >NUL 2>&1');
        }

        if (is_resource($process)) {
            @proc_terminate($process);
        }
    }
}
