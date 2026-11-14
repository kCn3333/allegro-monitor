# <img src="docs/assets/branding/logo-128.png" width="48" height="48" alt=""> Allegro Monitor

[![CI](https://img.shields.io/github/actions/workflow/status/kCn3333/allegro-monitor/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=white&labelColor=131b26)](https://github.com/kCn3333/allegro-monitor/actions/workflows/ci.yml)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=5FA04E&labelColor=131b26)](https://nodejs.org/en/download)
[![TypeScript 5](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=3178C6&labelColor=131b26)](https://www.typescriptlang.org/)
[![Fastify 5](https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white&labelColor=131b26)](https://fastify.dev/)
[![SQLite 3](https://img.shields.io/badge/SQLite-3-74c7ec?style=flat-square&logo=sqlite&logoColor=74c7ec&labelColor=131b26)](https://sqlite.org/)
[![Docker GHCR](https://img.shields.io/badge/Docker-GHCR-2496ED?style=flat-square&logo=docker&logoColor=2496ED&labelColor=131b26)](https://github.com/kCn3333/allegro-monitor/pkgs/container/allegro-monitor)

Allegro Monitor wykrywa nowe oferty i produkty w zapisanych wyszukiwaniach Allegro. Rozszerzenie przeglądarki odczytuje wyniki z otwartych kart, a backend zapisuje je w SQLite i udostępnia panel aplikacji. Powiadomienia są dostępne w rozszerzeniu oraz opcjonalnie w Telegramie.

Rozszerzenie używa Chromium Manifest V3; instrukcja instalacji w panelu dotyczy Vivaldi.

[Historia wydań](CHANGELOG.md) · [Uruchomienie](#uruchomienie-w-dockerze) · [Konfiguracja](#konfiguracja) · [Rozszerzenie](#instalacja-i-parowanie-rozszerzenia) · [Licencja MIT](LICENSE)

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

2. Uzupełnij `APP_PUBLIC_URL`, `APP_USERNAME`, `APP_PASSWORD` i `APP_SESSION_SECRET`. Telegram jest opcjonalny również w dostarczonym Compose. Aby otrzymywać wiadomości, ustaw `TELEGRAM_BOT_TOKEN` oraz odbiorców w `TELEGRAM_CHAT_IDS` (lub starszej zmiennej `TELEGRAM_CHAT_ID`).
3. Uruchom aplikację:

   ```bash
   docker compose up -d
   ```

[compose.yml](compose.yml) pobiera obraz `ghcr.io/kcn3333/allegro-monitor:latest`. Dane SQLite są zapisywane w trwałym wolumenie `allegro-monitor-data`. Domyślny port aplikacji to `3000`.

### Ręczna aktualizacja przez Portainera

Workflow [CI](.github/workflows/ci.yml) uruchamia testy i buduje aplikację, a po zmianach w `main` publikuje obraz GHCR z tagami `latest` oraz pełnym SHA commita.

Przed publikacją Trivy skanuje pakiety systemowe i zależności aplikacji w końcowym obrazie runtime. Podatności HIGH/CRITICAL z dostępną poprawką oraz błędy skanera lub pobierania bazy blokują publikację. Pełny raport JSON, obejmujący wszystkie poziomy i podatności bez poprawki, jest zapisywany jako artefakt `trivy-report-<SHA>` także po odrzuceniu obrazu. Po zatwierdzeniu publikowany jest ten sam lokalny obraz, bez ponownego budowania.

Aktualizację wykonuje się ręcznie w Portainerze:

1. Poczekaj na pomyślne zakończenie publikacji obrazu w CI. Dla prywatnego obrazu Portainer musi mieć skonfigurowany dostęp do rejestru `ghcr.io` z uprawnieniem odczytu pakietu.
2. W zmiennych środowiskowych stosu ustaw `IMAGE_TAG` na `latest` albo pełny SHA wybranego, opublikowanego commita. Compose użyje obrazu `ghcr.io/kcn3333/allegro-monitor:<IMAGE_TAG>`.
3. Zaktualizuj stos z włączonym ponownym pobraniem obrazu, zachowując pozostałe zmienne, porty i wolumen danych. Po aktualizacji sprawdź stan kontenera oraz dostęp do panelu.

Przed aktualizacją wykonaj [backup i próbne odtworzenie](docs/operations.md). Dokument opisuje też zgodność obrazu z bazą przy rollbacku.

## Konfiguracja

Aplikacja odczytuje `.env` przy starcie. Zmienne przekazane w środowisku mają pierwszeństwo. Poniższa tabela opisuje zmienne aplikacji; dostarczony Compose przekazuje tylko wskazane w nim ustawienia.

| Zmienna | Znaczenie i wartość domyślna |
| --- | --- |
| `APP_PUBLIC_URL` | Adres HTTPS serwera, np. `https://monitor.example.com`, bez ścieżki, parametrów, fragmentu i danych logowania. Wymagany w produkcji oraz do wygenerowania rozszerzenia. |
| `APP_USERNAME`, `APP_PASSWORD` | Dane logowania do panelu. Wymagane w produkcji. |
| `APP_SESSION_SECRET` | Sekret sesji; w produkcji co najmniej 32 losowe znaki. |
| `TELEGRAM_BOT_TOKEN` | Opcjonalny token bota, także przy uruchomieniu przez Compose. Wiadomości wymagają tokenu i co najmniej jednego odbiorcy; bez tokenu backend i powiadomienia rozszerzenia działają nadal. |
| `TELEGRAM_CHAT_IDS`, `TELEGRAM_CHAT_ID` | Lista odbiorców oddzielonych przecinkami. `TELEGRAM_CHAT_IDS` ma pierwszeństwo; tylko jej brak lub pusty ciąg powoduje użycie starszej `TELEGRAM_CHAT_ID`. Elementy są przycinane, duplikaty i niepoprawne wpisy pomijane. Niepusta, lecz niepoprawna wartość nie uruchamia fallbacku. |
| `DATABASE_PATH` | Ścieżka bazy SQLite: lokalnie `./data/monitor.sqlite`; w Compose ustawiona na `/app/data/monitor.sqlite`. |
| `EXTENSION_DIRECTORY` | Katalog szablonu rozszerzenia z manifestem, skryptami i ikonami. Domyślnie `./extension`, względem katalogu roboczego. Niepusta błędna ścieżka nie jest zastępowana domyślną i może uniemożliwić start. |
| `LISTING_RETENTION_CHECKS` | Liczba kolejnych udanych sprawdzeń bez danej oferty, po której jej zapis jest usuwany. Domyślnie `5`; efektywne minimum to `2`. Wartość `1` oznacza `2`, a brak, pusta wartość, zero, liczba ujemna, ułamek lub wartość nienumeryczna oznaczają `5`. |
| `APP_TIME_ZONE` | Strefa czasowa panelu. Brak lub pusta wartość oznaczają `Europe/Warsaw`. Nieprawidłowa niepusta strefa nie uruchamia fallbacku i może powodować błędy formatowania dat. |
| `HOST` | Adres nasłuchu aplikacji. Brak lub pusta wartość oznaczają `0.0.0.0`. Dostarczony Compose ustawia go na stałe. |
| `PORT` | Port nasłuchu aplikacji, domyślnie `3000`. Brak, pusta wartość, zero, liczba ujemna, ułamek lub wartość nienumeryczna oznaczają `3000`. Dostarczony Compose wyznacza go przez `APP_PORT`. |
| `TRUST_PROXY` | Opcjonalna lista zaufanych adresów IP lub zakresów CIDR rozdzielonych przecinkami (IPv4/IPv6). Domyślnie pusta: `trustProxy=false`. Nie przyjmuje wartości logicznych, liczby hopów ani zakresów `/0`; błędna konfiguracja zatrzymuje start aplikacji. |

Zmienne używane wyłącznie przez Compose, nieodczytywane przez `config.ts`:

| Zmienna | Działanie w dostarczonym Compose |
| --- | --- |
| `APP_PORT` | Domyślnie `3000`. Ustawia `PORT` w kontenerze oraz port publikowany na hoście i docelowy port kontenera. |
| `BIND_ADDRESS` | Domyślnie `0.0.0.0`. Adres interfejsu hosta, na którym publikowany jest port; nie zmienia `HOST` aplikacji w kontenerze. |
| `IMAGE_TAG` | Domyślnie `latest`. Wybiera tag obrazu `ghcr.io/kcn3333/allegro-monitor`, np. pełny SHA opublikowanego commita. |

Brak lub pusta wartość tych trzech zmiennych wybiera wartość domyślną. Niepuste błędne wartości nie są automatycznie poprawiane; mogą spowodować błąd mapowania portów lub pobierania obrazu.

Dostarczony Compose nadpisuje `HOST` na `0.0.0.0`, `PORT` na wartość `APP_PORT` i `DATABASE_PATH` na `/app/data/monitor.sqlite`. Wpisy `HOST`, `PORT` i `DATABASE_PATH` w pliku `.env` nie zmieniają tych ustawień kontenera. `EXTENSION_DIRECTORY` nie jest przekazywane — obraz korzysta z `/app/extension`. Pozostałe zmienne z tabeli aplikacji są przekazywane, a `APP_TIME_ZONE` ustawia również `TZ` kontenera. Sam plik `.env` nie jest kopiowany ani montowany do obrazu. Obraz uruchamia aplikację z `NODE_ENV=production`, więc obowiązują produkcyjne wymagania danych logowania, sekretu sesji i publicznego adresu HTTPS.

Port aplikacji powinien być dostępny wyłącznie dla reverse proxy lub tunelu. Dla proxy działającego na tym samym hoście można ustawić `BIND_ADDRESS=127.0.0.1`.

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

Serwer przechowuje maksymalnie 100 aktywnych kodów parowania. Po osiągnięciu limitu generowanie zwraca `429` z `Retry-After` w sekundach do najbliższego wygaśnięcia. Kolejne kody nie unieważniają wcześniejszych; miejsce zwalnia się po zużyciu lub wygaśnięciu kodu.

Backend generuje paczkę przy starcie na podstawie `APP_PUBLIC_URL`. ZIP zawiera adres serwera, uprawnienia dla jego domeny oraz wymagane zasoby, w tym lokalne ikony. Hasła, tokeny i plik `.env` nie są dołączane. Katalog `extension/` w repozytorium jest szablonem; do instalacji służy paczka pobrana z panelu.

Adres serwera w rozszerzeniu jest tylko do odczytu. Po zmianie `APP_PUBLIC_URL` uruchom ponownie backend, pobierz nową paczkę, przeładuj rozszerzenie i sparuj je ponownie. Token poprzedniego serwera nie jest wysyłany pod nowy adres.

## Dostęp i urządzenia

Panel umożliwia przeglądanie sparowanych urządzeń, zmianę ich nazw i odwoływanie dostępu. Odłączenie urządzenia natychmiast unieważnia jego token, zachowując wspólne monitory i historię. Odłączenie wszystkich urządzeń unieważnia również oczekujące kody parowania.

Sesje panelu i tokeny rozszerzeń są niezależne; serwer przechowuje ich hashe. Zmiana danych logowania lub sekretu unieważnia sesje panelu. Tokeny rozszerzeń nie wygasają automatycznie i wymagają osobnego odwołania.

Produkcja wymaga HTTPS. Po 20 błędnych próbach logowania z jednego adresu źródłowego w ciągu 15 minut serwer blokuje kolejne próby do końca tego okresu, zwracając `429` i `Retry-After`. Parowanie dopuszcza 12 prób na adres w ciągu 15 minut; udane parowanie zeruje licznik.

Bez `TRUST_PROXY` limity korzystają z adresu bezpośredniego połączenia, więc użytkownicy za wspólnym proxy współdzielą limit. Po skonfigurowaniu listy [Fastify](https://fastify.dev/docs/latest/Reference/Server/#trustproxy) ustala adres klienta z `X-Forwarded-For`, sprawdzając łańcuch od strony aplikacji do pierwszego niezaufanego adresu. Nagłówek od niezaufanego nadawcy nie zmienia adresu używanego do limitowania.

Wpisz wyłącznie rzeczywiste adresy lub zakresy zaufanych proxy swojej infrastruktury, widoczne z aplikacji. Proxy musi prawidłowo przekazywać nagłówki `X-Forwarded-*`, w szczególności usuwać lub poprawnie uzupełniać `X-Forwarded-For`, aby klient nie mógł narzucić adresu. Przy wielu proxy każdy zaufany hop musi odpowiadać rzeczywistej konfiguracji sieci. Aplikacja nie zawiera domyślnej listy zaufanych proxy. Ustawienie nie dodaje zapisywania IP urządzeń.

## Powiadomienia i przechowywanie danych

- **Rozszerzenie:** odbiera partie do 50 zdarzeń, zapisuje je przed potwierdzeniem odbioru i usuwa duplikaty według `eventId`. Lista mieści 100 nieprzeczytanych pozycji; jej wyczyszczenie pozwala odebrać kolejne. Zdarzenia i oczekujące partie są przechowywane przez 30 dni. Potwierdzenie odbioru nie potwierdza wyświetlenia powiadomienia przez system.
- **Telegram:** kolejka jest zapisywana razem z ofertami, osobno dla każdego odbiorcy. Wysyłka obejmuje do 12 prób, timeout 10 sekund i rosnące odstępy z uwzględnieniem `retry_after`. Przerwane zadanie można ponowić po 60 sekundach; zakończone zadania są przechowywane przez 30 dni. Niejednoznaczny wynik wysyłki może skutkować duplikatem wiadomości.
- **Oferty i wykluczenia:** usunięcie oferty przez retencję nie zmniejsza łącznego licznika nowości. Wykluczenia dotyczą pełnego identyfikatora `offer:ID` lub `product:UUID`.

Projekt jest udostępniany na [licencji MIT](LICENSE). Ikony Font Awesome podlegają [odrębnej licencji CC BY 4.0](THIRD_PARTY_NOTICES.md).
