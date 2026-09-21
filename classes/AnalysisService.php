<?php

declare(strict_types=1);

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/AnalysisInterface.php';

/**
 * Запускает scripts/analyzer.py через proc_open и разбирает его JSON-вывод.
 */
final class AnalysisService implements AnalysisInterface
{
    private const SCRIPT = __DIR__ . '/../scripts/analyzer.py';

    /**
     * @param callable(float $fraction, string $phase): void|null $onProgress
     * @param callable(): bool|null                             $stopCheck  Вернуть true — прервать анализ.
     */
    public function runAnalysis(string $filePath, ?callable $onProgress = null, ?callable $stopCheck = null): array
    {
        if (!is_file($filePath)) {
            return $this->error('Файл не найден: ' . $filePath);
        }

        // На Windows неблокирующее чтение stderr-pipe отдаёт данные «оптом» после
        // завершения процесса. Поэтому живой прогресс python пишет в JSON-файл,
        // а PHP его опрашивает в цикле — так события реально оказываются вовремя.
        $progressFile = '';

        if ($onProgress !== null) {
            $progressFile = sys_get_temp_dir() . '/sp_live_' . bin2hex(random_bytes(4)) . '.json';
        }

        $command = [STEMPLAYER_PYTHON, self::SCRIPT, $filePath];

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
            return $this->error('Не удалось запустить python (' . STEMPLAYER_PYTHON . '). Проверьте config.php.');
        }

        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $stdout      = '';
        $stderr      = '';
        $lastFrac    = -1.0;
        $lastPhase   = '';

        // На Windows неблокирующее чтение pipe прозрачно блокируется, пока
        // дочерний процесс не закрыл канал: стрим "замерзает" до конца анализа.
        // Прогресс берём только из JSON-файла, а pipes вычитываем уже ПОСЛЕ
        // завершения процесса (там и скопится весь вывод).
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

        if (($stopCheck !== null && $stopCheck()) || $exitCode === -1) {
            return $this->error('Анализ прерван пользователем', $stderr);
        }

        $data = $this->parseStdout($stdout);

        if ($exitCode !== 0 || $data === null || ($data['status'] ?? '') === 'error') {
            $message = is_array($data) ? ($data['message'] ?? 'Неизвестная ошибка анализатора') : 'Некорректный вывод анализатора';
            return $this->error($message, $stderr);
        }

        $data['stderr'] = trim($stderr);
        return $data;
    }

    /**
     * Принудительно завершает python-процесс и его дочерние (ffmpeg).
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
     * Читает JSON-файл прогресса, который непрерывно перезаписывает python.
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

    /**
     * Ищет последнюю непустую строку с валидным JSON.
     *
     * @return array<string, mixed>|null
     */
    private function parseStdout(string $stdout): ?array
    {
        $lines = array_filter(array_map('trim', explode("\n", $stdout)), fn (string $l): bool => $l !== '');

        if ($lines === []) {
            return null;
        }

        $decoded = json_decode((string) end($lines), true);

        return is_array($decoded) ? $decoded : null;
    }

    /**
     * @return array{status: 'error', message: string, stderr?: string}
     */
    private function error(string $message, string $stderr = ''): array
    {
        $result = ['status' => 'error', 'message' => $message];

        if ($stderr !== '') {
            $result['stderr'] = $stderr;
        }

        return $result;
    }
}