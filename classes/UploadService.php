<?php

declare(strict_types=1);

/**
 * Загрузка треков (POST multipart) в inbox/.
 */
final class UploadService
{
    /**
     * @param array<string, mixed>|null $files Содержимое $_FILES['files'] (или null).
     *
     * @return array<string, mixed> Готовый ответ API.
     */
    public function handle(?array $files, string $inboxDir): array
    {
        if ($files === null || !is_array($files['name'] ?? null)) {
            return ['status' => 'error', 'message' => 'Поле files[] не получено. Возможно, превышен лимит post_max_size.'];
        }

        if (!is_dir($inboxDir) && !mkdir($inboxDir, 0777, true) && !is_dir($inboxDir)) {
            return ['status' => 'error', 'message' => 'Не удалось создать папку inbox/.'];
        }

        $uploaded = [];
        $rejected = [];

        foreach ($files['name'] as $i => $origName) {
            if (($files['error'][$i] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
                $rejected[] = ['name' => (string) $origName, 'reason' => self::uploadErrorText((int) ($files['error'][$i] ?? UPLOAD_ERR_NO_FILE))];
                continue;
            }

            $ext = strtolower(pathinfo((string) $origName, PATHINFO_EXTENSION));

            if (!in_array($ext, STEMPLAYER_AUDIO_EXT, true)) {
                $rejected[] = ['name' => (string) $origName, 'reason' => 'Неподдерживаемое расширение .' . $ext];
                continue;
            }

            $safeName = self::sanitizeUploadName((string) $origName);
            $dest     = self::uniqueInboxPath($inboxDir, $safeName);

            if (!move_uploaded_file((string) $files['tmp_name'][$i], $dest)) {
                $rejected[] = ['name' => (string) $origName, 'reason' => 'Не удалось сохранить файл'];
                continue;
            }

            $uploaded[] = basename($dest);
        }

        return [
            'status'   => 'ok',
            'uploaded' => $uploaded,
            'rejected' => $rejected,
        ];
    }

    private static function uploadErrorText(int $code): string
    {
        return match ($code) {
            UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'Файл превышает допустимый размер',
            UPLOAD_ERR_PARTIAL => 'Файл загружен не полностью',
            UPLOAD_ERR_NO_FILE => 'Файл не передан',
            UPLOAD_ERR_NO_TMP_DIR => 'Временная папка не найдена',
            UPLOAD_ERR_CANT_WRITE => 'Не удалось записать файл',
            default => 'Ошибка загрузки (код ' . $code . ')',
        };
    }

    /**
     * Чистит имя файла: убирает путь и хвостовые символы, запрещённые в Windows.
     */
    private static function sanitizeUploadName(string $name): string
    {
        $base = basename($name);
        $base = preg_replace('/[<>:"\/\\|?*\\x00-\\x1F]+/u', '_', $base) ?? $base;
        $base = preg_replace('/[\s.]+$/u', '', $base) ?? $base;

        return $base === '' ? 'track_' . time() . '.mp3' : $base;
    }

    /**
     * Если файл уже есть в inbox/, добавляет суффикс _1, _2, ...
     */
    private static function uniqueInboxPath(string $inboxDir, string $name): string
    {
        $candidate = $inboxDir . DIRECTORY_SEPARATOR . $name;

        if (!file_exists($candidate)) {
            return $candidate;
        }

        $ext  = pathinfo($name, PATHINFO_EXTENSION);
        $base = pathinfo($name, PATHINFO_FILENAME);
        $n    = 1;

        do {
            $candidate = $inboxDir . DIRECTORY_SEPARATOR . sprintf('%s_%d.%s', $base, $n, $ext);
            $n++;
        } while (file_exists($candidate));

        return $candidate;
    }
}