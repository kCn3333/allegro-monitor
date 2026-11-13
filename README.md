<h1><img src="docs/assets/branding/logo-128.png" alt="" width="64" height="64" align="middle"> Allegro Monitor</h1>

[![CI](https://img.shields.io/github/actions/workflow/status/kCn3333/allegro-monitor/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=white&labelColor=2b2b2b&passingColor=d8612c&failingColor=b42318)](https://github.com/kCn3333/allegro-monitor/actions/workflows/ci.yml)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-d8612c?style=flat-square&logo=nodedotjs&logoColor=white&labelColor=2b2b2b)](https://nodejs.org/en/download)
[![TypeScript 5](https://img.shields.io/badge/TypeScript-5-d8612c?style=flat-square&logo=typescript&logoColor=white&labelColor=2b2b2b)](https://www.typescriptlang.org/)
[![Fastify 5](https://img.shields.io/badge/Fastify-5-d8612c?style=flat-square&logo=fastify&logoColor=white&labelColor=2b2b2b)](https://fastify.dev/)
[![SQLite 3](https://img.shields.io/badge/SQLite-3-d8612c?style=flat-square&logo=sqlite&logoColor=white&labelColor=2b2b2b)](https://sqlite.org/)
[![Docker GHCR](https://img.shields.io/badge/Docker-GHCR-d8612c?style=flat-square&logo=docker&logoColor=white&labelColor=2b2b2b)](https://github.com/kCn3333/allegro-monitor/pkgs/container/allegro-monitor)
[![Licencja MIT](https://img.shields.io/badge/License-MIT-d8612c?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=2b2b2b)](LICENSE)

Allegro Monitor wykrywa nowe oferty i produkty w zapisanych wyszukiwaniach Allegro. Rozszerzenie przeglądarki odczytuje wyniki z otwartych kart, a backend zapisuje je w SQLite i udostępnia panel aplikacji. Powiadomienia są dostępne w rozszerzeniu oraz opcjonalnie w Telegramie.

Rozszerzenie używa Chromium Manifest V3; instrukcja instalacji w panelu dotyczy Vivaldi.

## Zasady działania

- Pierwsze sprawdzenie zapisuje stan początkowy bez powiadomień. Kolejne wykrywają nowe identyfikatory ofert i produktów. Oznaczenie „Nowa” dotyczy ostatniego udanego sprawdzenia.
- Rozszerzenie odświeża karty kolejno, zgodnie z interwałem monitora: 1, 5, 15, 30 lub 60 minut. Adres karty musi odpowiadać zapisanemu wyszukiwaniu, łącznie z kategorią, filtrami i paginacją.
- Przeglądarka i karta wyszukiwania muszą pozostać otwarte, a komputer nie może być uśpiony. Karta nie musi być aktywna. Backend sam nie pobiera wyników z Allegro.
- Monitory i wykluczenia są wspólne dla sparowanych urządzeń. Synchronizacja odbywa się co minutę. Wyciszenie powiadomień na urządzeniu nie zatrzymuje sprawdzania.
- Captcha lub blokada Allegro przerywa bieżący cykl i wymaga interwencji użytkownika. Po błędzie lub przerwaniu workera ponowna automatyczna próba następuje po co najmniej 10 minutach albo po dłuższym interwale monitora.
- Urządzenia sprawdzają wyszukiwania niezależnie; aplikacja nie koordynuje ich harmonogramów.

## Uruchomienie w Dockerze

Wymagane są Docker Compose i adres HTTPS prowadzący do aplikacji przez reverse proxy lub tunel.

1. Skopiuj konfigurację:

   ```bash
   cp .env.example .env
   ```

2. Uzupełnij `APP_PUBLIC_URL`, `APP_USERNAME`, `APP_PASSWORD` i `APP_SESSION_SECRET`. Dostarczony plik Compose wymaga również `TELEGRAM_BOT_TOKEN`; aby otrzymywać wiadomości, ustaw odbiorców w `TELEGRAM_CHAT_IDS`.
3. Uruchom aplikację:

   ```bash
   docker compose up -d
   ```

[compose.yml](compose.yml) pobiera obraz `ghcr.io/kcn3333/allegro-monitor:latest`. Dane SQLite są zapisywane w trwałym wolumenie `allegro-monitor-data`. Domyślny port aplikacji to `3000`.

## Konfiguracja

Aplikacja odczytuje `.env` przy starcie. Zmienne przekazane w środowisku mają pierwszeństwo.

| Zmienna | Znaczenie i wartość domyślna |
| --- | --- |
| `APP_PUBLIC_URL` | Adres HTTPS serwera, np. `https://monitor.example.com`, bez ścieżki, parametrów, fragmentu i danych logowania. Wymagany w produkcji oraz do wygenerowania rozszerzenia. |
| `APP_USERNAME`, `APP_PASSWORD` | Dane logowania do panelu. Wymagane w produkcji. |
| `APP_SESSION_SECRET` | Sekret sesji; w produkcji co najmniej 32 losowe znaki. |
| `TELEGRAM_BOT_TOKEN` | Token bota. Backend może działać bez niego, ale dostarczony Compose wymaga niepustej wartości. |
| `TELEGRAM_CHAT_IDS` | Identyfikatory odbiorców oddzielone przecinkami. Jeśli zmienna jest pusta, używana jest starsza `TELEGRAM_CHAT_ID`. |
| `DATABASE_PATH` | Ścieżka bazy SQLite: lokalnie `./data/monitor.sqlite`; w Compose ustawiona na `/app/data/monitor.sqlite`. |
| `LISTING_RETENTION_CHECKS` | Liczba kolejnych udanych sprawdzeń bez danej oferty, po której jej zapis jest usuwany. Domyślnie `5`. |
| `APP_TIME_ZONE` | Strefa czasowa panelu. Domyślnie `Europe/Warsaw`. |
| `HOST`, `PORT` | Adres nasłuchu i port przy uruchomieniu lokalnym. Domyślnie `0.0.0.0` i `3000`. |

Dodatkowe ustawienia Compose: `IMAGE_TAG` (domyślnie `latest`), `APP_PORT` (`3000`) oraz `BIND_ADDRESS` (`0.0.0.0`). Port aplikacji powinien być dostępny wyłącznie dla reverse proxy lub tunelu. Dla proxy działającego na tym samym hoście można ustawić `BIND_ADDRESS=127.0.0.1`.

Odbiorca wiadomości Telegram musi rozpocząć rozmowę z botem, np. poleceniem `/start`, albo dodać bota do grupy.

## Uruchomienie lokalne

Wymagane są Node.js 22.5 lub nowszy z linii 22 oraz program `zip`, używany do generowania paczki rozszerzenia.

```bash
npm ci
cp .env.example .env
```

Uzupełnij `.env`, a następnie uruchom backend:

```bash
node --experimental-sqlite --import tsx src/main.ts
```

Panel jest dostępny pod `http://localhost:3000`. Korzystanie z rozszerzenia wymaga ustawienia `APP_PUBLIC_URL` i udostępnienia backendu pod tym adresem HTTPS.

## Instalacja i parowanie rozszerzenia

1. Zaloguj się do panelu i otwórz stronę `/extension`.
2. Pobierz ZIP i rozpakuj go w stałym katalogu.
3. Otwórz `vivaldi://extensions`, włącz „Tryb dewelopera” i wybierz „Załaduj rozpakowane”. Wskaż katalog z rozpakowaną paczką.
4. W panelu wygeneruj kod parowania i wpisz go w oknie rozszerzenia. Kod jest jednorazowy i ważny przez 10 minut.
5. Otwórz wyszukiwanie Allegro, wybierz w rozszerzeniu „Monitoruj tę kartę” i ustaw interwał.

Backend generuje paczkę przy starcie na podstawie `APP_PUBLIC_URL`. ZIP zawiera adres serwera, uprawnienia dla jego domeny oraz wymagane zasoby, w tym lokalne ikony. Hasła, tokeny i plik `.env` nie są dołączane. Katalog `extension/` w repozytorium jest szablonem; do instalacji służy paczka pobrana z panelu.

Adres serwera w rozszerzeniu jest tylko do odczytu. Po zmianie `APP_PUBLIC_URL` uruchom ponownie backend, pobierz nową paczkę, przeładuj rozszerzenie i sparuj je ponownie. Token poprzedniego serwera nie jest wysyłany pod nowy adres.

## Dostęp i urządzenia

Panel umożliwia przeglądanie sparowanych urządzeń, zmianę ich nazw i odwoływanie dostępu. Odłączenie urządzenia natychmiast unieważnia jego token, zachowując wspólne monitory i historię. Odłączenie wszystkich urządzeń unieważnia również oczekujące kody parowania.

Sesje panelu i tokeny rozszerzeń są niezależne; serwer przechowuje ich hashe. Zmiana danych logowania lub sekretu unieważnia sesje panelu. Tokeny rozszerzeń nie wygasają automatycznie i wymagają osobnego odwołania.

Produkcja wymaga HTTPS. Po 20 błędnych próbach logowania z jednego adresu źródłowego w ciągu 15 minut serwer blokuje kolejne próby do końca tego okresu, zwracając `429` i `Retry-After`. Aplikacja nie włącza `trustProxy`, dlatego użytkownicy za wspólnym proxy współdzielą ten limit.

## Powiadomienia i przechowywanie danych

- **Rozszerzenie:** odbiera partie do 50 zdarzeń, zapisuje je przed potwierdzeniem odbioru i usuwa duplikaty według `eventId`. Lista mieści 100 nieprzeczytanych pozycji; jej wyczyszczenie pozwala odebrać kolejne. Zdarzenia i oczekujące partie są przechowywane przez 30 dni. Potwierdzenie odbioru nie potwierdza wyświetlenia powiadomienia przez system.
- **Telegram:** kolejka jest zapisywana razem z ofertami, osobno dla każdego odbiorcy. Wysyłka obejmuje do 12 prób, timeout 10 sekund i rosnące odstępy z uwzględnieniem `retry_after`. Przerwane zadanie można ponowić po 60 sekundach; zakończone zadania są przechowywane przez 30 dni. Niejednoznaczny wynik wysyłki może skutkować duplikatem wiadomości.
- **Oferty i wykluczenia:** usunięcie oferty przez retencję nie zmniejsza łącznego licznika nowości. Wykluczenia dotyczą pełnego identyfikatora `offer:ID` lub `product:UUID`.

Projekt jest udostępniany na [licencji MIT](LICENSE). Ikony Font Awesome podlegają [odrębnej licencji CC BY 4.0](THIRD_PARTY_NOTICES.md).

[Historia wydań](CHANGELOG.md)
