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
 * Две особенности Windows/PHP 8.2, из-за которых реализация неочевидна
 * (обе проверены на analyzer.py, ~12 c работы):
 *
 *  1. stream_set_blocking(false) на конвейерах proc_open НЕ работает —
 *     возвращает false, и fread() пустого канала блокируется до прихода
 *     данных. Поэтому stdout читается только после stream_select().
 *  2. В одном stream_select() нельзя держать stderr вместе со stdout:
 *     select ждёт готовности ВСЕХ переданных потоков, а stderr у скрипта
 *     обычно молчит до самого конца — цикл вставал на нём и все этапы
 *     приезжали разом на финале (load@+0.2c, дальше bpm/key/meta@+12c).
 *     Поэтому stderr уводится во временный файл: нет конвейера — нет
 *     блокировки, нет и переполнения буфера в 64 KB на долгом выводе.
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

        $stderrFile = tempnam(sys_get_temp_dir(), 'stempy_');

        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => $stderrFile !== false ? ['file', $stderrFile, 'w'] : ['pipe', 'w'],
        ];

        // env не передаём: вместе с $_SERVER на Windows PHP искажает окружение
        // дочернего процесса (python не находится), поэтому наследуем его как есть.
        $process = proc_open($command, $descriptors, $pipes, dirname(__DIR__));

        if (!is_resource($process)) {
            $this->removeStderrFile($stderrFile);

            return [
                'stdout'     => '',
                'stderr'     => 'Не удалось запустить python (' . $interpreter . '). Проверьте config.php.',
                'exit_code'  => -1,
                'terminated' => false,
            ];
        }

        fclose($pipes[0]);

        $stdout   = '';
        $stageBuf = '';
        $stopped  = false;

        // Сколько ждём конца stdout, если процесс умер, а EOF не наступил
        // (конвейер могут держать внуки — ffmpeg и т.п.).
        $eofGraceDeadline = 0.0;

        $write  = null;
        $except = null;

        try {
            while (true) {
                $read  = [$pipes[1]];
                $ready = @stream_select($read, $write, $except, 0, 200_000);

                if ($ready !== false && $ready > 0) {
                    $chunk = (string) @fread($pipes[1], 65536);

                    if ($chunk !== '') {
                        $stdout   .= $chunk;
                        $stageBuf .= $chunk;

                        while (($nl = strpos($stageBuf, "\n")) !== false) {
                            $line     = substr($stageBuf, 0, $nl);
                            $stageBuf = substr($stageBuf, $nl + 1);
                            $this->handleLine(trim($line), $onStage);
                        }
                    }
                }

                $status  = proc_get_status($process);
                $running = (bool) ($status['running'] ?? false);

                if ($running && $stopCheck !== null && $stopCheck()) {
                    $this->terminate($process);
                    $stopped = true;
                    break;
                }

                // Выход только когда процесс мёртв И stdout дочитан: одного
                // флага running мало, proc_get_status() на этой сборке может
                // вернуть running=false на живом процессе, и тогда данные
                // приехали бы уже на финальном сливе.
                if (!$running && feof($pipes[1])) {
                    break;
                }

                if (!$running) {
                    if ($eofGraceDeadline === 0.0) {
                        $eofGraceDeadline = microtime(true) + 30.0;
                    } elseif (microtime(true) > $eofGraceDeadline) {
                        break;
                    }

                    usleep(50_000);
                }
            }
        } finally {
            // Добираем остаток из конвейера, пока он отдаёт данные.
            for ($i = 0; $i < 256; $i++) {
                $read  = [$pipes[1]];
                $ready = @stream_select($read, $write, $except, 0, 50_000);

                if ($ready === false || $ready === 0) {
                    break;
                }

                $chunk = (string) @fread($pipes[1], 65536);

                if ($chunk === '') {
                    break;
                }

                $stdout   .= $chunk;
                $stageBuf .= $chunk;

                while (($nl = strpos($stageBuf, "\n")) !== false) {
                    $line     = substr($stageBuf, 0, $nl);
                    $stageBuf = substr($stageBuf, $nl + 1);
                    $this->handleLine(trim($line), $onStage);
                }

                if (feof($pipes[1])) {
                    break;
                }
            }

            fclose($pipes[1]);

            if (isset($pipes[2]) && is_resource($pipes[2])) {
                fclose($pipes[2]);
            }
        }

        $exitCode = proc_close($process);
        $stderr   = $this->readStderrFile($stderrFile);
        $this->removeStderrFile($stderrFile);

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

    private function readStderrFile($file): string
    {
        if ($file === false || !is_file($file)) {
            return '';
        }

        return trim((string) @file_get_contents($file));
    }

    private function removeStderrFile($file): void
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
