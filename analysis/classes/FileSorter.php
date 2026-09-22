<?php

declare(strict_types=1);

require_once __DIR__ . '/SortingInterface.php';

/**
 * Отвечает за создание безопасных имён каталогов и перенос файлов
 * в music/sorted/ по схеме BPM{value}_Key{normalized}.
 */
final class FileSorter implements SortingInterface
{
    // music/sorted лежит в общем для модулей каталоге проекта.
    private const SORTED_DIR = __DIR__ . '/../../music/sorted';

    /**
     * Преобразует BPM и Key в безопасное имя папки без спецсимволов.
     *
     * Правила:
     *  - '#' (диез)  -> 's'       (C#m -> CsM)
     *  - 'b' (бемоль) -> 'f'      (Ab  -> Af)
     *  - 'm' (минор)  -> 'M'      (C#m -> CsM)
     *  - пробелы и прочие разделители -> '_'
     *
     * @param string $bpm Значение темпа (например "124").
     * @param string $key Тональность (например "C#m", "Ab", "A minor").
     */
    public function sanitizeFolderName(string $bpm, string $key): string
    {
        $cleanBpm = preg_replace('/\D/', '', $bpm) ?: '0';

        $cleanKey = str_replace(['#', 'b', ' ', '-', '/'], ['s', 'f', '_', '_', '_'], trim($key));
        $cleanKey = str_replace(['major', 'minor'], ['', 'm'], strtolower($cleanKey));
        $cleanKey = ucfirst($cleanKey);

        // Минорный суффикс приводим к верхнему регистру (C#m -> CsM).
        if (str_ends_with($cleanKey, 'm') && strlen($cleanKey) > 1) {
            $cleanKey = substr($cleanKey, 0, -1) . 'M';
        }

        return sprintf('BPM%d_Key%s', (int) $cleanBpm, $cleanKey);
    }

    /**
     * Копирует исходный файл в папку music/sorted/BPMxxx_KeyXxx/.
     *
     * @return string|false Полный путь к скопированному файлу или false при ошибке.
     */
    public function moveToSorted(string $sourcePath, string $bpm, string $key): string|false
    {
        if (!is_file($sourcePath)) {
            return false;
        }

        $folderName = $this->sanitizeFolderName($bpm, $key);
        $targetDir  = self::SORTED_DIR . DIRECTORY_SEPARATOR . $folderName;

        if (!is_dir($targetDir) && !mkdir($targetDir, 0777, true) && !is_dir($targetDir)) {
            return false;
        }

        $destPath = $targetDir . DIRECTORY_SEPARATOR . basename($sourcePath);

        if (!copy($sourcePath, $destPath)) {
            return false;
        }

        return $destPath;
    }

    /**
     * Перечисляет каталоги отсортированной музыки (для визуализации дерева).
     *
     * @return array<int, array{name: string, files: array<int, string>}>
     */
    public function listSortedFolders(): array
    {
        $result = [];

        if (!is_dir(self::SORTED_DIR)) {
            return $result;
        }

        $folders = scandir(self::SORTED_DIR) ?: [];

        foreach ($folders as $folder) {
            if ($folder === '.' || $folder === '..') {
                continue;
            }

            $full = self::SORTED_DIR . DIRECTORY_SEPARATOR . $folder;

            if (!is_dir($full)) {
                continue;
            }

            $files   = array_values(array_filter(scandir($full) ?: [], fn (string $f): bool => !in_array($f, ['.', '..'], true)));
            $result[] = ['name' => $folder, 'files' => $files];
        }

        return $result;
    }
}