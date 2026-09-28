<?php

declare(strict_types=1);

/**
 * Реестр треков из music/sorted/ для модуля «Стемы».
 *
 * Считает hash-ID каждого трека:
 *   ID = substr(md5(<имя файла> + BPM + Key), 0, 8)
 * и определяет, какие стемы уже готовы в подкаталоге {ID}/.
 */
final class StemRegistry
{
    // music/ лежит в корне проекта, модуль на уровень ниже.
    private const SORTED_DIR = __DIR__ . '/../../music/sorted';

    /**
     * Все треки из music/sorted/ со статусом стемов.
     *
     * @return list<array{
     *   folder: string,
     *   name: string,
     *   bpm: int,
     *   key: string,
     *   id: string,
     *   done: bool,
     *   stems: array<string, string|null>
     * }>
     */
    public function listTracks(): array
    {
        $rows = [];

        foreach ($this->sortedFolders() as $folder => $parsed) {
            $dir = self::SORTED_DIR . '/' . $folder;
            $key = $this->decodeKey($parsed['key']);

            // 1) Ещё не разделённые треки: исходник mp3 в папке BPM…_Key… на месте.
            foreach (glob($dir . '/*.mp3') ?: [] as $file) {
                if (!is_file($file)) {
                    continue;
                }

                $name = basename($file);
                $id   = $this->idFor($name, $parsed['bpm'], $key);

                $rows[$id] = [
                    'folder'      => $folder,
                    'name'        => $name,
                    'bpm'         => $parsed['bpm'],
                    'key'         => $key,
                    'id'          => $id,
                    'done'        => $this->isDone($folder, $id),
                    'stems'       => $this->stems($folder, $id),
                ];
            }

            // 2) Уже разделённые, чей исходник удалён (STEMGEN_DELETE_SOURCE):
            //    строка восстанавливается из {id}/meta.json — трек не пропадает из таблицы.
            foreach (glob($dir . '/[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]', GLOB_ONLYDIR) ?: [] as $stemDir) {
                $id = basename($stemDir);

                if (isset($rows[$id])) {
                    continue;
                }

                $meta = $this->readMeta($stemDir . '/meta.json');
                $name = (string) ($meta['original_name'] ?? '');

                $rows[$id] = [
                    'folder'      => $folder,
                    'name'        => $name !== '' ? $name : ('Трек ' . $id),
                    'bpm'         => $parsed['bpm'],
                    'key'         => $key,
                    'id'          => $id,
                    'done'        => $this->isDone($folder, $id),
                    'stems'       => $this->stems($folder, $id),
                ];
            }
        }

        uasort($rows, static fn (array $a, array $b): int => strnatcasecmp($a['name'], $b['name']));

        return array_values($rows);
    }

    /**
     * Готовы все стемы модели?
     */
    public function isDone(string $folder, string $id): bool
    {
        $dir = $this->stemDir($folder, $id);

        foreach (STEMGEN_STEMS as $stem) {
            if (!is_file($dir . '/' . $id . '_' . $stem . '.mp3')) {
                return false;
            }
        }

        return is_file($dir . '/meta.json');
    }

    /**
     * URL каждого стема (null, если файла ещё нет). Ключи — имена стемов.
     *
     * @return array<string, string|null>
     */
    public function stems(string $folder, string $id): array
    {
        $out  = [];
        $dir  = $this->stemDir($folder, $id);

        foreach (STEMGEN_STEMS as $stem) {
            $file = $dir . '/' . $id . '_' . $stem . '.mp3';
            $out[$stem] = is_file($file) ? $this->stemUrl($folder, $id, $stem) : null;
        }

        return $out;
    }

    /**
     * ID трека по схеме модуля «Стемы».
     */
    public function idFor(string $fileName, int $bpm, string $key): string
    {
        return substr(md5($fileName . $bpm . $key), 0, 8);
    }

    /**
     * Абсолютный путь к каталогу стемов трека.
     */
    public function stemDir(string $folder, string $id): string
    {
        return self::SORTED_DIR . '/' . $folder . '/' . $id;
    }

    /**
     * Абсолютный путь к исходнику трека.
     */
    public function sourcePath(string $folder, string $name): string
    {
        return self::SORTED_DIR . '/' . $folder . '/' . $name;
    }

    /**
     * Безопасно разрешает путь — только внутри music/sorted/.
     */
    public function resolveInSorted(string $path): ?string
    {
        $root = realpath(self::SORTED_DIR);
        $real = realpath($path);

        if ($root === false || $real === false) {
            return null;
        }

        return str_starts_with($real . DIRECTORY_SEPARATOR, $root . DIRECTORY_SEPARATOR)
            ? $real
            : null;
    }

    /**
     * Папки BPM…_Key… как список [имя => ['bpm', 'key']].
     *
     * @return array<string, array{bpm: int, key: string}>
     */
    private function sortedFolders(): array
    {
        $out = [];

        foreach (glob(self::SORTED_DIR . '/BPM*_Key*', GLOB_ONLYDIR) ?: [] as $dir) {
            $name = basename($dir);

            if (!preg_match('/^BPM(\d+)_Key(.+)$/', $name, $m)) {
                continue;
            }

            $out[$name] = ['bpm' => (int) $m[1], 'key' => $m[2]];
        }

        return $out;
    }

    /**
     * "AsM" → "A#m", "AM" → "Am", "FsM" → "F#m", "C" → "C".
     */
    private function decodeKey(string $folderKey): string
    {
        if (!preg_match('/^([A-G])([sf]?)(M?)$/', $folderKey, $m)) {
            return $folderKey;
        }

        $acc = $m[2] === 's' ? '#' : ($m[2] === 'f' ? 'b' : '');

        return $m[1] . $acc . ($m[3] === 'M' ? 'm' : '');
    }

    /**
     * meta.json каталога стемов (original_name/bpm/key) или null.
     */
    private function readMeta(string $file): ?array
    {
        if (!is_file($file)) {
            return null;
        }

        $data = json_decode((string) file_get_contents($file), true);

        return is_array($data) ? $data : null;
    }

    private function stemUrl(string $folder, string $id, string $stem): string
    {
        return '../music/sorted/' . rawurlencode($folder) . '/' . $id . '/' . $id . '_' . $stem . '.mp3';
    }
}