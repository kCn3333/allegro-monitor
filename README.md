# Allegro Monitor

Lekka, prywatna aplikacja monitorująca wyniki wyszukiwania Allegro. Pierwsze sprawdzenie zapamiętuje bieżące oferty; następne wysyłają powiadomienia tylko dla nowych pozycji.

## Funkcje

- kilka niezależnych URL-i wyszukiwania i interwałów;
- pełny Chromium uruchamiany w wirtualnym ekranie tylko podczas sprawdzania;
- trwały profil przeglądarki zachowujący cookies między sprawdzeniami;
- SQLite bez osobnego serwera bazy;
- proste GUI bez frameworka frontendowego;
- opcjonalne powiadomienia Telegram i Basic Auth;
- obraz Docker oraz GitHub Actions.

## Uruchomienie lokalne

Wymagane są Node.js 22 i Chromium dla Playwrighta.

```bash
cp .env.example .env
npm install
npx playwright install chromium
npm run dev
```

Panel będzie dostępny pod `http://localhost:3000`.

## Telegram

1. Utwórz bota przez `@BotFather` i wpisz token do `TELEGRAM_BOT_TOKEN`.
2. Napisz wiadomość do bota.
3. Odczytaj `chat.id` z `https://api.telegram.org/bot<TOKEN>/getUpdates` i ustaw `TELEGRAM_CHAT_ID`.

Bez tych wartości monitor działa normalnie, ale nie wysyła wiadomości.

## Docker

```bash
export TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_CHAT_ID="..."
export APP_USERNAME="admin"
export APP_PASSWORD="..."
docker compose up -d
```

Port aplikacji jest publikowany na wszystkich interfejsach hosta, aby mógł się z nim połączyć Cloudflare Tunnel działający w osobnym kontenerze. Nie należy przekierowywać tego portu na routerze bezpośrednio do Internetu. Baza SQLite jest przechowywana w nazwanym wolumenie Docker `allegro-monitor-data`.

W Portainerze wartości należy dodać w sekcji **Environment variables** stacka. Wymagane są `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `APP_USERNAME`, `APP_PASSWORD` i `VNC_PASSWORD`. Opcjonalne `APP_PORT`, `VNC_WEB_PORT`, `CHECK_TICK_SECONDS` oraz `IMAGE_TAG` mają wartości domyślne odpowiednio `3000`, `6080`, `30` i `latest`.

Chromium działa stale w trybie graficznym na wirtualnym ekranie Xvfb i używa jednej karty. Profil jest przechowywany w wolumenie `allegro-monitor-browser-profile`, a screenshoty stron blokady lub błędów trafiają do katalogu `diagnostics` w wolumenie `allegro-monitor-data`. Port noVNC jest dostępny wyłącznie na `127.0.0.1` serwera. Przy captcha utwórz tunel `ssh -L 6080:127.0.0.1:6080 UZYTKOWNIK@SERWER`, otwórz `http://127.0.0.1:6080/vnc.html?autoconnect=true`, podaj `VNC_PASSWORD` i wykonaj ręczną weryfikację.

## Deployment

Workflow buduje obraz `ghcr.io/kcn3333/allegro-monitor`. Ręczny workflow `Deploy` wymaga sekretów środowiska `production`:

- `DEPLOY_HOST` — adres serwera;
- `DEPLOY_USER` — użytkownik SSH;
- `DEPLOY_SSH_KEY` — prywatny klucz wdrożeniowy.

Na serwerze katalog `/opt/allegro-monitor` powinien zawierać `compose.yml`. Dane pozostają w wolumenie Docker `allegro-monitor-data`, niezależnie od ponownego utworzenia kontenera. Konto wdrożeniowe musi mieć dostęp do polecenia `docker compose`.

## Ograniczenia

Allegro może zmienić HTML lub zażądać captcha. Aplikacja nie próbuje omijać takich zabezpieczeń: zapisuje błąd w panelu i ponawia sprawdzenie później. Zalecany interwał to co najmniej 10 minut.

Centra danych bywają blokowane niezależnie od częstotliwości zapytań. Przed właściwym wdrożeniem trzeba wykonać próbę z docelowego serwera. Jeśli serwer stale otrzymuje HTTP 403 lub captcha, monitor nie będzie tam niezawodny i należy użyć oficjalnych powiadomień Allegro albo zrezygnować z tej lokalizacji.
