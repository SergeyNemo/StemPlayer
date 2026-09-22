<?php

declare(strict_types=1);

/**
 * HTTP-ответы: JSON и SSE-события.
 */
final class Http
{
    /**
     * Заголовки SSE-стрима. Отключаем всё буферизующее (gzip, ob_*),
     * иначе события приходят пачками.
     */
    public static function sseHeaders(): void
    {
        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        ini_set('zlib.output_compression', 'Off');
        while (ob_get_level() > 0) {
            ob_end_flush();
        }
        header('Content-Type: text/event-stream; charset=utf-8');
        header('Cache-Control: no-cache, no-transform');
        header('Connection: keep-alive');
        header('X-Accel-Buffering: no');
        ob_implicit_flush(true);
    }

    /**
     * Отправляет именованное SSE-событие и сбрасывает буфер.
     *
     * @param array<string, mixed> $payload
     */
    public static function sseEmit(string $event, array $payload): void
    {
        echo 'event: ' . $event . "\n";
        echo 'data: ' . self::encode($payload) . "\n\n";
        flush();
    }

    /**
     * @param array<string, mixed> $payload
     */
    public static function jsonResponse(array $payload): never
    {
        header('Content-Type: application/json; charset=utf-8');
        echo self::encode($payload);
        exit;
    }

    /**
     * @param array<string, mixed> $payload
     */
    private static function encode(array $payload): string
    {
        return json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
}