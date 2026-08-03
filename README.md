# Allegro Monitor

Lekka, prywatna aplikacja monitorująca wyniki wyszukiwania Allegro. Pierwsze sprawdzenie zapamiętuje bieżące oferty; następne wysyłają powiadomienia tylko dla nowych pozycji.

## Funkcje

- kilka niezależnych URL-i wyszukiwania i interwałów;
- rozszerzenie Manifest V3 dla Vivaldi i innych przeglądarek Chromium;
- odświeżanie wskazanych, otwartych kart wyszukiwania;
- badge, powiadomienia systemowe i podświetlanie nowych ofert;
- SQLite bez osobnego serwera bazy;
- proste GUI bez frameworka frontendowego;
- opcjonalne powiadomienia Telegram i Basic Auth;
- obraz Docker oraz GitHub Actions.

## Uruchomienie lokalne

Wymagany jest Node.js 22.

```bash
cp .env.example .env
npm install
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

W Portainerze wartości należy dodać w sekcji **Environment variables** stacka. Wymagane są `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `APP_USERNAME` i `APP_PASSWORD`. Opcjonalne `APP_PORT` oraz `IMAGE_TAG` mają wartości domyślne odpowiednio `3000` i `latest`.

## Rozszerzenie Vivaldi

Po uruchomieniu serwera przejdź do `/extension`, pobierz ZIP i postępuj według instrukcji. Rozszerzenie paruje się z serwerem jednorazowym kodem ważnym przez 10 minut. Następnie otwórz wyszukiwanie Allegro i wybierz w popupie **Monitoruj tę kartę**.

Rozszerzenie odświeża wskazane karty pojedynczo. Pierwszy odczyt tworzy stan początkowy; kolejne nowe oferty pojawiają się w badge, popupie, powiadomieniu systemowym, panelu WWW i na Telegramie.

## Deployment

Workflow buduje obraz `ghcr.io/kcn3333/allegro-monitor`. Ręczny workflow `Deploy` wymaga sekretów środowiska `production`:

- `DEPLOY_HOST` — adres serwera;
- `DEPLOY_USER` — użytkownik SSH;
- `DEPLOY_SSH_KEY` — prywatny klucz wdrożeniowy.

Na serwerze katalog `/opt/allegro-monitor` powinien zawierać `compose.yml`. Dane pozostają w wolumenie Docker `allegro-monitor-data`, niezależnie od ponownego utworzenia kontenera. Konto wdrożeniowe musi mieć dostęp do polecenia `docker compose`.

## Ograniczenia

Vivaldi musi być uruchomiony, a komputer nie może być uśpiony. Rozszerzenie nie omija captcha: pozostawia kartę do ręcznej weryfikacji i wstrzymuje pozostałe sprawdzenia w danym cyklu. Zalecany interwał to co najmniej 10 minut.
