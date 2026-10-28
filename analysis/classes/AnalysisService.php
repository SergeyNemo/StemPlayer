<?php

declare(strict_types=1);

require_once __DIR__ . '/../../core/PythonRunner.php';
require_once __DIR__ . '/AnalysisInterface.php';

/**
 * Запускает scripts/analyzer.py через core\PythonRunner и разбирает JSON-вывод.
 */
final class AnalysisService implements AnalysisInterface
{
    private const SCRIPT = __DIR__ . '/../scripts/analyzer.py';

    /**
     * @param callable(): bool|null $stopCheck Вернуть true — прервать анализ.
     * @param callable(string): void|null $onStage Этап текущей работы пайтона.
     */
    public function runAnalysis(string $filePath, ?callable $stopCheck = null, ?callable $onStage = null): array
    {
        if (!is_file($filePath)) {
            return $this->error('Файл не найден: ' . $filePath);
        }

        $result = (new PythonRunner())->run(self::SCRIPT, [$filePath], $stopCheck, '', $onStage);

        if ($result['terminated'] || $result['exit_code'] === -1) {
            return $this->error('Анализ остановлен', $result['stderr']);
        }

        $data = $this->parseStdout($result['stdout']);

        if ($result['exit_code'] !== 0 || $data === null || ($data['status'] ?? '') === 'error') {
            $message = is_array($data) ? ($data['message'] ?? 'Неизвестная ошибка анализатора') : 'Некорректный вывод анализатора';
            return $this->error($message, $result['stderr']);
        }

        if ($result['stderr'] !== '') {
            $data['stderr'] = $result['stderr'];
        }

        return $data;
    }

    /**
     * Ищет строку с результатом: последнюю, где есть поле "status".
     *
     * Раньше бралась просто последняя непустая строка, но в stdout теперь
     * попадают и служебные {"stage": ...}, поэтому ориентируемся на признак
     * результата, а не на позицию.
     *
     * @return array<string, mixed>|null
     */
    private function parseStdout(string $stdout): ?array
    {
        $lines = array_reverse(array_filter(
            array_map('trim', explode("\n", $stdout)),
            fn (string $l): bool => $l !== ''
        ));

        foreach ($lines as $line) {
            $decoded = json_decode($line, true);

            if (is_array($decoded) && isset($decoded['status'])) {
                return $decoded;
            }
        }

        return null;
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