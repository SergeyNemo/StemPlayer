<?php

declare(strict_types=1);

require_once __DIR__ . '/StemGenInterface.php';
require_once __DIR__ . '/../../core/PythonRunner.php';
require_once __DIR__ . '/StemRegistry.php';

/**
 * Запускает stem_splitter.py через core\PythonRunner и проверяет результат.
 *
 * Использует демоусовский venv (STEMGEN_PYTHON), поэтому скрипт выполняется
 * отдельным python — тем же, в котором установлен demucs+torch.
 */
final class StemService implements StemGenInterface
{
    private const SCRIPT = __DIR__ . '/../scripts/stem_splitter.py';

    private StemRegistry $registry;

    public function __construct(?StemRegistry $registry = null)
    {
        $this->registry = $registry ?? new StemRegistry();
    }

    public function generateStems(
        string $filePath,
        int $bpm,
        string $key,
        string $id,
        string $outputDir,
        ?callable $stopCheck = null,
        ?callable $onStage = null
    ): array {
        // --- Безопасность: только внутри music/sorted/. ---
        if ($this->registry->resolveInSorted($filePath) === null) {
            return $this->error('Путь вне music/sorted/: ' . $filePath);
        }

        if (!preg_match('/^[0-9a-f]{8}$/', $id)) {
            return $this->error('ID каталога стемов некорректен: ' . $id);
        }

        // outputDir — это BPM…_Key… (родитель для {id}/), он же существует на диске.
        if ($this->registry->resolveInSorted($outputDir) === null) {
            return $this->error('Каталог-родитель вне music/sorted/: ' . $outputDir);
        }

        if (!is_file($filePath)) {
            return $this->error('Файл не найден: ' . $filePath);
        }

        $result = (new PythonRunner())->run(
            self::SCRIPT,
            [
                $filePath,
                $outputDir,
                $id,
                (string) $bpm,
                $key,
                STEMGEN_DEMUCS_MODEL,
                (string) STEMGEN_MP3_BITRATE,
                '0', // two-stems отключён: цель модуля — 4 стема
            ],
            $stopCheck,
            STEMGEN_PYTHON,
            $onStage
        );

        if ($result['terminated'] || $result['exit_code'] === -1) {
            return $this->error('Разделение прервано пользователем', $result['stderr']);
        }

        $data = $this->parseStdout($result['stdout']);

        if ($result['exit_code'] !== 0 || $data === null || ($data['status'] ?? '') === 'error') {
            $message = is_array($data) ? ($data['message'] ?? 'Неизвестная ошибка Demucs')
                                      : 'Некорректный вывод stem_splitter.py';
            return $this->error($message, $result['stderr']);
        }

        // --- Верифицируем файлы, потом уже трогаем исходник. ---
        $dir = $this->registry->stemDir(
            $this->folderNameFor($filePath),
            $id
        );

        $present = [];

        foreach (STEMGEN_STEMS as $stem) {
            if (is_file($dir . '/' . $id . '_' . $stem . '.mp3')) {
                $present[] = $stem;
            }
        }

        if (!is_file($dir . '/meta.json') || count($present) === 0) {
            return $this->error('Результат неполный: ожидались стемы и meta.json в ' . $dir);
        }

        if (STEMGEN_DELETE_SOURCE && is_file($filePath)) {
            @unlink($filePath);
        }

        return [
            'status' => 'done',
            'id'     => $id,
            'stems'  => $present,
        ];
    }

    /**
     * Имя папки BPM…_Key… для файла (получается от резолва пути).
     */
    private function folderNameFor(string $filePath): string
    {
        $resolved = $this->registry->resolveInSorted($filePath);

        if ($resolved === null) {
            return '';
        }

        $rel = substr($resolved, strlen(realpath(__DIR__ . '/../../music/sorted') . DIRECTORY_SEPARATOR));

        return strtok($rel, '/\\') ?: '';
    }

    /**
     * Берём из вывода скрипта итоговую строку JSON.
     *
     * Строк теперь много: сначала идут этапы {"stage": …} (их разбирает
     * PythonRunner и по ним рисуется шкала), а в конце - одна итоговая с
     * "status". Поэтому ищем СНИЗУ вверх последнюю строку с "status": если
     * demucs или ffmpeg допишет в stdout что-то своё, результат не
     * потеряется, как было бы при тупом "последняя строка".
     *
     * @return array<string, mixed>|null
     */
    private function parseStdout(string $stdout): ?array
    {
        $lines = array_filter(array_map('trim', explode("\n", $stdout)), fn (string $l): bool => $l !== '');

        $fallback = null;

        foreach (array_reverse($lines) as $line) {
            $decoded = json_decode($line, true);

            if (!is_array($decoded)) {
                continue;
            }

            if (isset($decoded['status'])) {
                return $decoded;
            }

            $fallback ??= $decoded;
        }

        return $fallback;
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