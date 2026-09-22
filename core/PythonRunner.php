<?php

declare(strict_types=1);

/**
 * Запуск внешнего python-скрипта через proc_open с живым прогрессом.
 *
 * На Windows неблокирующее чтение stderr-pipe отдаёт данные «оптом» после
 * завершения процесса. Поэтому скрипт пишет живой прогресс в json-файл
 * (последним аргументом командной строки), а этот класс опрашивает файл
 * в цикле proc_get_status — так события реально оказываются вовремя.
 */
final class PythonRunner
{
    /**
     * @param callable(float $fraction, string $phase): void|null $onProgress
     * @param callable(): bool|null                              $stopCheck Вернуть true — прервать процесс.
     *
     * @return array{
     *   stdout: string,
     *   stderr: string,
     *   exit_code: int,
     *   terminated: bool
     * }
     */
    public function run(string $script, array $cliArgs = [], ?callable $onProgress = null, ?callable $stopCheck = null): array
    {
        $progressFile = '';

        if ($onProgress !== null) {
            $progressFile = sys_get_temp_dir() . '/sp_live_' . bin2hex(random_bytes(4)) . '.json';
        }

        $command = [STEMPLAYER_PYTHON, $script, ...$cliArgs];

        if ($progressFile !== '') {
            $command[] = $progressFile;
        }

        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];

        // env не передаём: вместе с $_SERVER на Windows PHP искажает окружение
        // дочернего процесса (python не находится), поэтому наследуем его как есть.
        $process = proc_open($command, $descriptors, $pipes, dirname(__DIR__));

        if (!is_resource($process)) {
            return [
                'stdout'     => '',
                'stderr'     => 'Не удалось запустить python (' . STEMPLAYER_PYTHON . '). Проверьте config.php.',
                'exit_code'  => -1,
                'terminated' => false,
            ];
        }

        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $stdout    = '';
        $stderr    = '';
        $lastFrac  = -1.0;
        $lastPhase = '';
        $stopped   = false;

        try {
            do {
                if ($progressFile !== '') {
                    $this->pollProgressFile($progressFile, $lastFrac, $lastPhase, $onProgress);
                }

                $status = proc_get_status($process);

                if ($status['running']) {
                    usleep(20_000);

                    if ($stopCheck !== null && $stopCheck()) {
                        $this->terminate($process);
                        $stopped = true;
                        break;
                    }
                }
            } while ($status['running']);

            stream_set_blocking($pipes[1], true);
            stream_set_blocking($pipes[2], true);
            $stdout .= stream_get_contents($pipes[1]) ?: '';
            $stderr  = trim((string) (stream_get_contents($pipes[2]) ?: ''));

            if ($progressFile !== '') {
                $this->pollProgressFile($progressFile, $lastFrac, $lastPhase, $onProgress);
            }
        } finally {
            fclose($pipes[1]);
            fclose($pipes[2]);
            if ($progressFile !== '') {
                @unlink($progressFile);
                @unlink($progressFile . '.tmp');
            }
        }

        $exitCode = proc_close($process);

        return [
            'stdout'     => $stdout,
            'stderr'     => $stderr,
            'exit_code'  => $exitCode,
            'terminated' => $stopped,
        ];
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

    /**
     * Читает json-файл прогресса, который непрерывно перезаписывает python.
     *
     * @param callable(float, string): void|null $onProgress
     */
    private function pollProgressFile(string $file, float &$lastFrac, string &$lastPhase, ?callable $onProgress): void
    {
        $raw = @file_get_contents($file);

        if ($raw === false) {
            return;
        }

        $data = json_decode($raw, true);

        if (!is_array($data)) {
            return;
        }

        $frac  = (float) ($data['fraction'] ?? 0.0);
        $phase = (string) ($data['phase'] ?? '');

        if ($frac === $lastFrac && $phase === $lastPhase) {
            return;
        }

        $lastFrac  = $frac;
        $lastPhase = $phase;

        if ($onProgress !== null) {
            $onProgress($frac, $phase);
        }
    }
}