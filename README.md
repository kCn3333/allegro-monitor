# <img src="docs/assets/branding/logo-128.png" width="48" height="48" alt=""> Allegro Monitor

[![CI](https://img.shields.io/github/actions/workflow/status/kCn3333/allegro-monitor/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=white&labelColor=131b26)](https://github.com/kCn3333/allegro-monitor/actions/workflows/ci.yml)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=5FA04E&labelColor=131b26)](https://nodejs.org/en/download)
[![TypeScript 5](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=3178C6&labelColor=131b26)](https://www.typescriptlang.org/)
[![Fastify 5](https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white&labelColor=131b26)](https://fastify.dev/)
[![SQLite 3](https://img.shields.io/badge/SQLite-3-74c7ec?style=flat-square&logo=sqlite&logoColor=74c7ec&labelColor=131b26)](https://sqlite.org/)
[![Docker GHCR](https://img.shields.io/badge/Docker-GHCR-2496ED?style=flat-square&logo=docker&logoColor=2496ED&labelColor=131b26)](https://github.com/kCn3333/allegro-monitor/pkgs/container/allegro-monitor)

Allegro Monitor śledzi nowe oferty w zapisanych wyszukiwaniach Allegro. Rozszerzenie Chromium odczytuje wyniki z otwartych kart, a aplikacja zapisuje je w SQLite i udostępnia panel zarządzania. Projekt powstał z myślą o wyszukiwaniu rzadkich książek.

## Funkcje

- Monitorowanie wyszukiwań co 1, 5, 15, 30 lub 60 minut.
- Lista nowych ofert z cenami, miniaturami i linkami do Allegro.
- Powiadomienia przeglądarkowe i opcjonalnie Telegram.
- Wykluczanie niechcianych ofert, wstrzymywanie monitorów i wyciszanie powiadomień.
- Wspólne monitory na wielu urządzeniach oraz zarządzanie ich dostępem.

**Przeglądarka i karty wyszukiwań muszą pozostać otwarte, a komputer aktywny.** Backend sam nie pobiera ofert. Pierwsze sprawdzenie zapisuje stan początkowy bez powiadomień. Captcha wymaga ręcznej interwencji.

## Uruchomienie

1. Pobierz [compose.yml](compose.yml) i [.env.example](.env.example) do jednego katalogu. Skopiuj `.env.example` jako `.env` i uzupełnij wymagane ustawienia poniżej.
2. Uruchom :

   ```sh
   docker compose up -d
   ```

3. Zaloguj się do panelu, otwórz **Rozszerzenie**, pobierz ZIP i rozpakuj go do stałego katalogu. W `vivaldi://extensions` włącz tryb dewelopera i załaduj rozpakowany katalog.
4. Wygeneruj w panelu kod parowania (ważny 10 minut), wpisz go w rozszerzeniu i dodaj otwartą kartę wyszukiwania Allegro.

### Najważniejsze ustawienia

| Zmienna | Znaczenie |
| --- | --- |
| `APP_PUBLIC_URL` | Wymagany adres HTTPS aplikacji, bez ścieżki, parametrów i danych logowania. |
| `APP_USERNAME`, `APP_PASSWORD` | Wymagane dane logowania do panelu. |
| `APP_SESSION_SECRET` | Wymagany sekret: co najmniej 32 losowe znaki. Zachowaj go między aktualizacjami. |
| `TELEGRAM_BOT_TOKEN` | Opcjonalny token bota. Wiadomości wymagają także odbiorców; bez tokenu aplikacja i powiadomienia rozszerzenia działają nadal. |
| `TELEGRAM_CHAT_IDS` | Odbiorcy rozdzieleni przecinkami. Ma pierwszeństwo nad starszym `TELEGRAM_CHAT_ID`; fallback działa tylko przy braku lub pustej wartości. Odbiorca musi rozpocząć rozmowę z botem lub dodać go do grupy. |
| `APP_TIME_ZONE` | Strefa czasowa panelu, domyślnie `Europe/Warsaw`. |
| `LISTING_RETENTION_CHECKS` | Usunięcie oferty po tylu udanych sprawdzeniach bez niej. Domyślnie `5`, minimum `2`; `1` daje `2`, brak lub niepoprawna wartość daje `5`. |
| `TRUST_PROXY` | Opcjonalne zaufane adresy IP/CIDR rozdzielone przecinkami. Puste wyłącza zaufanie do proxy. Błędne wpisy, `true`, liczba hopów i `/0` blokują start. |
| `APP_PORT`, `BIND_ADDRESS` | Ustawienia Compose: port (`3000`) i interfejs hosta (`0.0.0.0`). Udostępniaj port tylko proxy lub tunelowi. |
| `IMAGE_TAG` | Tag obrazu GHCR: domyślnie `latest`; pełny SHA opublikowanego commita pozwala wybrać konkretną wersję. |

[Historia zmian](CHANGELOG.md) · [Licencja MIT](LICENSE) · [Licencja ikon](THIRD_PARTY_NOTICES.md)
