# Allegro Monitor

Lekka, prywatna aplikacja monitorująca wyniki wyszukiwania Allegro. Pierwsze sprawdzenie zapamiętuje bieżące oferty; następne wysyłają powiadomienia tylko dla nowych pozycji.

## Funkcje

- kilka niezależnych URL-i wyszukiwania i interwałów;
- rozszerzenie Manifest V3 dla Vivaldi i innych przeglądarek Chromium;
- odświeżanie wskazanych, otwartych kart wyszukiwania;
- badge, powiadomienia systemowe i podświetlanie nowych ofert;
- SQLite bez osobnego serwera bazy;
- proste GUI bez frameworka frontendowego;
- powiadomienia Telegram do wielu prywatnych czatów lub grup oraz Basic Auth;
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
2. Każdy odbiorca musi najpierw napisać do bota, a w przypadku grupy bot musi zostać do niej dodany. Nie musi być administratorem, a Privacy Mode może pozostać włączony.
3. Odczytaj wartości `chat.id` z `https://api.telegram.org/bot<TOKEN>/getUpdates`.
4. Ustaw rozdzieloną przecinkami listę, np. `TELEGRAM_CHAT_IDS=123456789,-1001234567890`. Starsza pojedyncza zmienna `TELEGRAM_CHAT_ID` nadal działa.

Token jest sekretem dającym pełną kontrolę nad botem: przechowuj go wyłącznie w zmiennych Portainera i nigdy nie przekazuj użytkownikom bota. Bez tokenu lub identyfikatorów czatów monitor działa normalnie, ale nie wysyła wiadomości.

## Docker

```bash
export TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_CHAT_IDS="123456789,-1001234567890"
export APP_USERNAME="admin"
export APP_PASSWORD="..."
docker compose up -d
```

Port aplikacji jest publikowany na wszystkich interfejsach hosta, aby mógł się z nim połączyć Cloudflare Tunnel działający w osobnym kontenerze. Nie należy przekierowywać tego portu na routerze bezpośrednio do Internetu; najlepiej ograniczyć go firewallem do hosta lub sieci Dockera. Baza SQLite jest przechowywana w nazwanym wolumenie Docker `allegro-monitor-data`.

W Portainerze wartości należy dodać w sekcji **Environment variables** stacka. Wymagane są `TELEGRAM_BOT_TOKEN`, `APP_USERNAME` i silne `APP_PASSWORD`; odbiorców określa `TELEGRAM_CHAT_IDS`. Opcjonalne `APP_PORT`, `IMAGE_TAG`, `LISTING_RETENTION_CHECKS` i `BIND_ADDRESS` mają wartości domyślne odpowiednio `3000`, `latest`, `5` oraz `0.0.0.0`. Jeśli `cloudflared` działa na hoście, ustaw `BIND_ADDRESS=127.0.0.1`; przy osobnym kontenerze pozostaw adres dostępny z jego sieci i ogranicz port firewallem.

## Baza i retencja

SQLite przechowuje konfigurację monitorów, skróty tokenów sparowanych rozszerzeń oraz metadane znalezionych pozycji: identyfikator Allegro, tytuł, URL, cenę, adres miniatury, pierwszy i ostatni czas obecności oraz liczbę kolejnych nieobecności. Nie przechowuje cookies, historii przeglądania, haseł Allegro ani tokenu Telegrama.

Pozycja nadal widoczna w wynikach pozostaje punktem odniesienia. Pozycja nieobecna przez `LISTING_RETENTION_CHECKS` kolejnych udanych odczytów jest usuwana, domyślnie po pięciu. Dzięki temu baza obejmuje głównie aktualny zestaw wyników i krótki bufor, zamiast rosnąć bez ograniczeń. Licznik `+N` monitora jest sumą nowych pozycji wykrytych od utworzenia punktu odniesienia i nie maleje podczas retencji.

Z panelu można wykluczyć dokładny produkt lub ofertę. Reguła używa pełnego identyfikatora Allegro (`product:UUID` albo `offer:ID`), a nie fragmentu tytułu, dlatego nie ukrywa innych wydań o podobnej nazwie. Wykluczenia są widoczne na karcie monitora i można je w każdej chwili cofnąć bez wygenerowania fałszywego powiadomienia.

## Rozszerzenie Vivaldi

Po uruchomieniu serwera przejdź do `/extension`, pobierz ZIP i postępuj według instrukcji. Rozszerzenie paruje się z serwerem jednorazowym kodem ważnym przez 10 minut. Następnie otwórz wyszukiwanie Allegro i wybierz w popupie **Monitoruj tę kartę**.

Rozszerzenie odświeża wskazane karty pojedynczo. Dostępne interwały to 1, 5, 15, 30 i 60 minut. Pierwszy odczyt tworzy stan początkowy; kolejne nowe oferty pojawiają się w badge, popupie, powiadomieniu systemowym, panelu WWW i na Telegramie.

Każde sparowane rozszerzenie co minutę oraz po zdarzeniu otwarcia lub zamknięcia karty przesyła heartbeat obecności i pobiera przypisaną wspólną listę monitorów. Monitor jest oznaczony jako aktywny, jeśli przynajmniej jedno urządzenie ma otwartą właściwą kartę i zgłosiło się w ciągu ostatnich trzech minut. Dzięki temu zamknięcie karty przez jedną osobę nie wyłącza wspólnego monitora działającego u drugiej. Dodanie, zmiana nazwy, wstrzymanie i usunięcie w panelu synchronizują się między rozszerzeniami. Usunięcie z popupu odłącza tylko bieżące rozszerzenie i nie kasuje wspólnej historii.

## Bezpieczeństwo

- panel i strona parowania wymagają Basic Auth, a API rozszerzenia osobnego losowego tokenu przechowywanego w Vivaldi;
- próby logowania i parowania są limitowane, formularze administracyjne odrzucają żądania cross-site, a odpowiedzi zawierają nagłówki ochronne;
- kontener działa bez roota, bez Linux capabilities, z systemem plików tylko do odczytu, limitem zasobów i rotacją logów;
- Cloudflare Tunnel powinien być jedyną drogą z Internetu; nie wystawiaj portu `APP_PORT` na routerze;
- dla dodatkowej ochrony panel można objąć Cloudflare Access, pozostawiając osobną regułę dostępu dla `/api/extension/*` używanego przez sparowane rozszerzenia;
- okresowo aktualizuj obraz i unieważniaj tokeny bota/parowania po podejrzeniu wycieku.

## Deployment

Workflow buduje obraz `ghcr.io/kcn3333/allegro-monitor`. Ręczny workflow `Deploy` wymaga sekretów środowiska `production`:

- `DEPLOY_HOST` — adres serwera;
- `DEPLOY_USER` — użytkownik SSH;
- `DEPLOY_SSH_KEY` — prywatny klucz wdrożeniowy.

Na serwerze katalog `/opt/allegro-monitor` powinien zawierać `compose.yml`. Dane pozostają w wolumenie Docker `allegro-monitor-data`, niezależnie od ponownego utworzenia kontenera. Konto wdrożeniowe musi mieć dostęp do polecenia `docker compose`.

## Ograniczenia

Vivaldi musi być uruchomiony, a komputer nie może być uśpiony. Rozszerzenie nie omija captcha: pozostawia kartę do ręcznej weryfikacji i wstrzymuje pozostałe sprawdzenia w danym cyklu. Interwał jednej minuty jest dostępny, ale zwiększa liczbę odświeżeń i ryzyko blokady Allegro; do stałej pracy rozsądniejszy jest interwał 5–15 minut.
