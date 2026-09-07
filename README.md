# Allegro Monitor

Lekka, prywatna aplikacja monitorująca wyniki wyszukiwania Allegro. Pierwsze sprawdzenie zapamiętuje bieżące oferty; następne wysyłają powiadomienia tylko dla nowych pozycji.

Zmiany w kolejnych wersjach opisuje [historia wydań](CHANGELOG.md).

## Funkcje

- kilka niezależnych URL-i wyszukiwania i interwałów;
- rozszerzenie Manifest V3 dla Vivaldi i innych przeglądarek Chromium;
- odświeżanie wskazanych, otwartych kart wyszukiwania;
- badge, powiadomienia systemowe i podświetlanie nowych ofert;
- SQLite bez osobnego serwera bazy;
- proste GUI bez frameworka frontendowego;
- powiadomienia Telegram do wielu prywatnych czatów lub grup oraz bezpieczne logowanie z opcją zapamiętania urządzenia;
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
export APP_SESSION_SECRET="losowy-sekret-o-dlugosci-minimum-32-znakow"
docker compose up -d
```

Port aplikacji jest publikowany na wszystkich interfejsach hosta, aby mógł się z nim połączyć Cloudflare Tunnel działający w osobnym kontenerze. Nie należy przekierowywać tego portu na routerze bezpośrednio do Internetu; najlepiej ograniczyć go firewallem do hosta lub sieci Dockera. Baza SQLite jest przechowywana w nazwanym wolumenie Docker `allegro-monitor-data`.

W Portainerze wartości należy dodać w sekcji **Environment variables** stacka. Wymagane są `APP_USERNAME`, silne `APP_PASSWORD` oraz losowy `APP_SESSION_SECRET` mający co najmniej 32 znaki; opcjonalny Telegram używa `TELEGRAM_BOT_TOKEN` i odbiorców z `TELEGRAM_CHAT_IDS`. Zmiana hasła lub sekretu unieważnia wszystkie aktywne sesje panelu. Opcjonalne `APP_PORT`, `IMAGE_TAG`, `LISTING_RETENTION_CHECKS` i `BIND_ADDRESS` mają wartości domyślne odpowiednio `3000`, `latest`, `5` oraz `0.0.0.0`. Jeśli `cloudflared` działa na hoście, ustaw `BIND_ADDRESS=127.0.0.1`; przy osobnym kontenerze pozostaw adres dostępny z jego sieci i ogranicz port firewallem.

## Baza i retencja

SQLite przechowuje konfigurację monitorów, skróty tokenów sparowanych rozszerzeń, hashe tokenów sesji panelu oraz metadane znalezionych pozycji: identyfikator Allegro, tytuł, URL, cenę, adres miniatury, pierwszy i ostatni czas obecności oraz liczbę kolejnych nieobecności. Nie przechowuje jawnych tokenów sesji, cookies, historii przeglądania, haseł Allegro ani tokenu Telegrama.

Pozycja nadal widoczna w wynikach pozostaje punktem odniesienia. Pozycja nieobecna przez `LISTING_RETENTION_CHECKS` kolejnych udanych odczytów jest usuwana, domyślnie po pięciu. Dzięki temu baza obejmuje głównie aktualny zestaw wyników i krótki bufor, zamiast rosnąć bez ograniczeń. Licznik `+N` monitora jest sumą nowych pozycji wykrytych od utworzenia punktu odniesienia i nie maleje podczas retencji.

Z panelu można wykluczyć dokładny produkt lub ofertę. Reguła używa pełnego identyfikatora Allegro (`product:UUID` albo `offer:ID`), a nie fragmentu tytułu, dlatego nie ukrywa innych wydań o podobnej nazwie. Wykluczenia są widoczne na karcie monitora i można je w każdej chwili cofnąć bez wygenerowania fałszywego powiadomienia.

## Rozszerzenie Vivaldi

Po uruchomieniu serwera przejdź do `/extension`, pobierz ZIP i postępuj według instrukcji. Rozszerzenie paruje się z serwerem jednorazowym kodem ważnym przez 10 minut. Następnie otwórz wyszukiwanie Allegro i wybierz w popupie **Monitoruj tę kartę**.

Rozszerzenie odświeża wskazane karty pojedynczo. Dostępne interwały to 1, 5, 15, 30 i 60 minut. Pierwszy odczyt tworzy stan początkowy; kolejne nowe oferty pojawiają się w badge, popupie, powiadomieniu systemowym, panelu WWW i na Telegramie.

Każde sparowane rozszerzenie co minutę oraz po zdarzeniu otwarcia lub zamknięcia karty przesyła heartbeat obecności i pobiera pełną wspólną listę monitorów. Monitor jest oznaczony jako aktywny, jeśli przynajmniej jedno urządzenie ma otwartą właściwą kartę i zgłosiło się w ciągu ostatnich trzech minut. Dzięki temu zamknięcie karty przez jedną osobę nie wyłącza wspólnego monitora działającego u drugiej. Dodanie, zmiana nazwy, wstrzymanie i usunięcie w panelu synchronizują się między rozszerzeniami. Popup nie pozwala kasować danych. Sprawdzanie przez otwartą kartę i lokalne powiadomienia są niezależne, a każde urządzenie ma osobny przełącznik powiadomień dla każdego monitora.

## Bezpieczeństwo

- panel i strona parowania wymagają logowania; opcja „Zapamiętaj mnie” używa 30-dniowego, automatycznie odnawianego cookie `HttpOnly`, `Secure` i `SameSite=Strict`, którego token jest przechowywany w SQLite wyłącznie jako hash;
- bez zaznaczenia opcji sesja jest cookie sesyjnym przeglądarki, a przycisk „Wyloguj” natychmiast unieważnia ją w bazie; API rozszerzenia używa oddzielnego losowego tokenu przechowywanego w Vivaldi;
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

## Niezawodność i aktualizacja 1.1.0

Najpierw zaktualizuj backend, następnie rozszerzenia do **1.1.0** (przeładuj je
w menedżerze rozszerzeń). Migracja SQLite dodaje `notification_batches` i
`telegram_jobs`; zachowuje monitory, wykluczenia, urządzenia, wyciszenia i sesje.
Nie wymaga ponownego parowania. Zwykły start to `npm start` (punkt wejścia
`dist/src/main.js`). Przed aktualizacją wykonaj standardową kopię bazy.

Rozszerzenie 1.1.0 negocjuje `notificationProtocol: 2`. Serwer utrwala partię
maksymalnie 50 zdarzeń, a rozszerzenie zapisuje ją przed uwierzytelnionym ACK.
ACK zawiera losowy identyfikator partii przypisany do urządzenia, nigdy dowolny
kursor. Powtórzenie pobrania/ACK jest bezpieczne. Trwały znacznik `eventId`
chroni przed duplikatami także po wyczyszczeniu nieprzeczytanych i restarcie.
Lista lokalna mieści 100 pozycji: gdy jest pełna, odbiór czeka na jej
wyczyszczenie i nie potwierdza niezapisanych zdarzeń. Zdarzenia i oczekujące
partie mają retencję 30 dni, egzekwowaną przy pobieraniu. Dłuższa nieobecność
lub pełna lista mogą więc oznaczać wygaśnięcie zaległych powiadomień.
Starsze rozszerzenia nadal używają odbioru bez ACK (z dotychczasowym ryzykiem
utraty odpowiedzi), ale nie otrzymują bez końca tych samych zdarzeń.
Ochrona ACK wymaga obu nowych komponentów; nie aktualizuj rozszerzenia przed
backendem. Lokalne powiadomienie systemowe jest dodatkiem do trwałej listy;
jego wyświetlenie przez system nie jest potwierdzane.

Telegram korzysta z trwałej kolejki, zapisywanej w tej samej transakcji co nowe
oferty. Endpoint wyników nie czeka na Telegram. Jeden worker na proces wysyła
jedno zadanie naraz; każde wywołanie ma timeout 10 s. Ponowienia mają rosnący
odstęp (do godziny), respektują `retry_after` dla 429 i kończą się najpóźniej
po 12 próbach. Błędy trwałe 4xx (poza 408/429) kończą zadanie; błąd 400 zdjęcia
pozwala raz przejść na tekst. 429 i błędy sieci nie uruchamiają tego obejścia.
Odbiorcy mają osobne statusy. Zadanie przerwane restartem wraca po wygaśnięciu
60-sekundowej dzierżawy. Zakończone zadania są usuwane po 30 dniach podczas
pracy workera. Brak tokenu wyłącza worker i tworzenie nowych zadań Telegrama,
bez wyłączania monitorowania. Nie ma gwarancji „exactly once”: niejednoznaczny
timeout lub restart po wysłaniu, ale przed zapisem sukcesu, może dać duplikat.

Karta musi mieć zgodny adres: domenę Allegro, ścieżkę i wszystkie parametry,
w tym cenę, kategorię i paginację. Kolejność parametrów i fragment nie mają
znaczenia. Zmiana filtrów nie powoduje nawigacji do starego adresu. Popup
rozróżnia sparowanie, udaną synchronizację, niedostępny serwer i odrzucony token.
Ręczne sprawdzanie działa również przy wyciszonych lokalnych powiadomieniach.

Limit logowania blokuje po 20 błędach w 15 minut, również dla poprawnego hasła,
z `429` i `Retry-After`. Pamięć limitera mieści najwyżej 10 000 wpisów, wygasłe
wpisy są usuwane przy żądaniach; przy zapełnieniu nowe adresy są blokowane do
zwolnienia miejsca. Limit jest lokalny dla procesu i zeruje się po restarcie.
Zaufanie do proxy pozostaje wyłączone: nagłówki z adresem klienta nie zmieniają
klucza limitu. Za proxy jego użytkownicy mogą współdzielić limit adresu proxy.

Weryfikacja lokalna na Node.js 22: `npm test`, `npm run check`, `npm run build`.
Testy używają Fastify inject, tymczasowych baz (w tym schematu z audytowanego
commita), mocków Telegrama i rzeczywistego skryptu rozszerzenia w kontekście VM
z mockiem API Chromium. Nie zastępują testu w prawdziwej przeglądarce ani
integracji z Allegro/Telegramem.

### Aktualizacja 1.1.1

Zaktualizuj backend, a następnie przeładuj rozszerzenie **1.1.1**. Kontrakt ACK
pozostaje bez zmian; komponenty po PR #2 są zgodne podczas aktualizacji.
Migracja dodaje `monitors.check_cycle` i `listings.new_in_cycle`. Zachowuje
oferty, punkt odniesienia (`initialized`), liczniki i kolejki; usuwa tylko
niejednoznaczne historyczne etykiety „Nowa”, bez odtwarzania alertów.

Przed odświeżeniem karty rozszerzenie zapisuje identyfikator próby i termin
odzyskania: 10 minut lub interwał monitora, jeśli jest dłuższy. Po przerwaniu
workera czeka do tego terminu, również przy ręcznej próbie wznowienia. Po
zakończonym błędzie automat stosuje tę samą przerwę liczoną od błędu; po
sukcesie obowiązuje zwykły interwał. Podświetlenie i synchronizacja powiadomień
nie wpływają na zapisany sukces. Jeśli backend przyjął wyniki tuż przed
przerwaniem lokalnego zapisu, następny odczyt nastąpi dopiero po terminie
odzyskania. To lokalna ochrona harmonogramu, bez koordynacji urządzeń.
