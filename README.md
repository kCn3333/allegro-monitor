# Allegro Monitor

Monitor wyszukiwań Allegro: rozszerzenie Chromium Manifest V3 odczytuje otwarte karty użytkownika i przesyła wyniki do backendu **Fastify / TypeScript / SQLite**. Panel WWW jest renderowany po stronie serwera. Powiadomienia trafiają do rozszerzenia i opcjonalnie do Telegrama.

## Działanie

- Pierwszy odczyt tworzy punkt odniesienia bez alertów. Kolejne wykrywają nowe identyfikatory ofert lub produktów; etykieta „Nowa” jest przypisana do cyklu sprawdzenia.
- Karta musi odpowiadać zapisanemu URL, łącznie z kategorią, filtrami i paginacją. Rozszerzenie sprawdza karty kolejno, z interwałem 1, 5, 15, 30 lub 60 minut.
- Monitory i wykluczenia są przechowywane na serwerze. Urządzenia synchronizują stan co minutę; lokalne wyciszenie powiadomień nie wyłącza sprawdzania.
- Przeglądarka musi działać na aktywnym komputerze. Captcha przerywa cykl. Błąd lub przerwanie workera powoduje trwałą przerwę co najmniej 10 minut albo dłuższy interwał monitora. Nie ma koordynacji sprawdzeń między urządzeniami.

## Uruchomienie lokalne

Wymagany Node.js 22. Uzupełnij dane logowania w `.env`; polecenie jawnie wczytuje ten plik.

```bash
npm ci
cp .env.example .env
# Uzupełnij .env przed uruchomieniem.
node --env-file=.env --experimental-sqlite --import tsx src/main.ts
```

Panel: `http://localhost:3000`. Aby zainstalować rozszerzenie, załaduj katalog `extension/` jako rozpakowane rozszerzenie Chromium i sparuj je kodem z `/extension`. W popupie wybierz „Monitoruj tę kartę” na otwartym wyszukiwaniu Allegro. Adres backendu przy parowaniu musi być objęty `host_permissions` w [manifeście](extension/manifest.json).

## Konfiguracja i Docker

| Zmienna | Znaczenie |
| --- | --- |
| `APP_USERNAME`, `APP_PASSWORD` | Dane logowania do panelu; wymagane w produkcji. |
| `APP_SESSION_SECRET` | Sekret sesji, minimum 32 znaki w produkcji. Zmiana danych logowania lub sekretu unieważnia sesje. |
| `TELEGRAM_BOT_TOKEN` | Token bota. Backend działa bez niego, ale dostarczony Compose wymaga niepustej wartości. |
| `TELEGRAM_CHAT_IDS` | Identyfikatory odbiorców oddzielone przecinkami; obsługiwana jest też starsza zmienna `TELEGRAM_CHAT_ID`. Odbiorca musi rozpocząć rozmowę z botem lub dodać go do grupy. |
| `DATABASE_PATH` | Plik SQLite; lokalnie `./data/monitor.sqlite`, w kontenerze `/app/data/monitor.sqlite`. |
| `LISTING_RETENTION_CHECKS` | Liczba kolejnych udanych odczytów bez oferty, po której jest usuwana; domyślnie 5. |

[compose.yml](compose.yml) pobiera obraz `ghcr.io/kcn3333/allegro-monitor`. Po uzupełnieniu `.env`:

```bash
docker compose up -d
```

Compose obsługuje `IMAGE_TAG` (domyślnie `latest`), `APP_PORT` (`3000`), `BIND_ADDRESS` (`0.0.0.0`) i `APP_TIME_ZONE` (`Europe/Warsaw`). Przy uruchomieniu bez Compose adres i port określają `HOST` i `PORT`. Dane kontenera znajdują się w wolumenie `allegro-monitor-data`.

Produkcja wymaga HTTPS. Port aplikacji powinien być dostępny tylko dla reverse proxy lub tunelu. `trustProxy` jest wyłączone: użytkownicy za jednym proxy współdzielą limit logowania — 20 błędów w 15 minut, potem `429` z `Retry-After`. Sesje panelu i tokeny rozszerzeń są oddzielne; serwer przechowuje ich hashe.

## Dostarczanie i retencja

- **Rozszerzenie:** partie do 50 zdarzeń, trwały zapis przed ACK i deduplikacja po `eventId`. Lista mieści 100 nieprzeczytanych pozycji; po zapełnieniu trzeba ją wyczyścić, aby odebrać resztę. Zdarzenia i oczekujące partie wygasają po 30 dniach. Wyświetlenie powiadomienia przez system nie ma osobnego potwierdzenia.
- **Telegram:** zlecenia są zapisywane w transakcji z ofertami, osobno dla odbiorców. Worker wysyła jedno zadanie naraz: timeout 10 s, do 12 prób, rosnący odstęp i obsługa `retry_after`. Przerwane zadania wracają po 60 s; zakończone mają retencję 30 dni. Niejednoznaczny timeout może spowodować duplikat — brak gwarancji „exactly once”.
- **Oferty:** retencja nie zmniejsza łącznego licznika nowości. Wykluczenia używają pełnego identyfikatora `offer:ID` lub `product:UUID`.

## Aktualizacja i weryfikacja

Przed aktualizacją wykonaj spójną kopię SQLite. Aktualizuj backend, następnie przeładuj rozszerzenie **1.1.1**. Migracje wykonują się przy starcie i zachowują dane oraz ustawienia. Migracja 1.1.1 usuwa tylko niejednoznaczne historyczne etykiety „Nowa”. Starsze rozszerzenia bez protokołu ACK zachowują ryzyko utraty powiadomienia przy utracie odpowiedzi.

```bash
npm test
npm run check
npm run build
```

Testy korzystają z tymczasowych baz, Fastify `inject` i mocków Chromium oraz Telegrama. Nie zastępują weryfikacji cyklu życia rozszerzenia w Vivaldi. Zbudowany backend uruchamia `npm start` ze zmiennymi przekazanymi w środowisku.

Push do `main` uruchamia CI i publikację obrazu. Wdrożenie jest osobnym, ręcznym workflow [Deploy](.github/workflows/deploy.yml), wymagającym sekretów `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` w środowisku `production` oraz pliku Compose w `/opt/allegro-monitor` na serwerze.

[Historia wydań](CHANGELOG.md)
