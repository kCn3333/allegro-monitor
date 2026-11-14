# Historia wydań

Numery wersji odnoszą się do rozszerzenia. Wpisy obejmują również powiązane
zmiany backendu; zmiany bez nowej wersji rozszerzenia mają osobne wpisy.
Daty wskazują dodanie zmian do repozytorium, nie wdrożenie na serwerze.

## 1.2.0 — 2026-11-14

- Poprawki interfejsu panelu aplikacji i rozszerzenia.

## 1.1.9 — 2026-11-14

- Service worker przyjmuje wiadomości tylko od własnego rozszerzenia; obcy lub brakujący identyfikator nadawcy jest odrzucany przed wykonaniem operacji. Aktualizacja zachowuje parowanie.

## Backend — 2026-11-14

- Wersja w nagłówku odpowiada manifestowi rozszerzenia. Link do GitHuba jest dostępny pod samą ikoną z opisem po najechaniu.
- Przyciski „Otwórz Allegro” i „Usuń” w kartach monitorów są wyrównane do prawej również na małych ekranach.
- Usunięto powtarzający się nagłówek „Lekki monitor nowych ofert Allegro”.

- Walidacja danych: odrzucane są błędne typy danych parowania i nazw monitorów przed zużyciem kodu lub zmianą danych. Miniatury wymagają HTTPS i domeny `allegroimg.com` lub jej subdomeny, bez danych logowania; błędne adresy są pomijane także w historii i kolejce Telegrama, bez odrzucania ofert.
- Kody parowania: ujednolicono sprawdzanie 10-minutowej ważności i usuwanie wygasłych wpisów. Limit 100 aktywnych kodów zwraca `429` z `Retry-After`; generowanie kolejnych nie unieważnia wcześniejszych.
- Ochrona panelu: poświadczenia są porównywane przez skróty HMAC-SHA-256 o stałej długości, bez unieważniania sesji. Dodano jawną listę `TRUST_PROXY` dla limitowania za zaufanym proxy. Skrypty panelu przeniesiono do lokalnych plików, usunięto inline handlery i `unsafe-inline` ze `script-src`; dodano testy Chromium.
- Telegram i konfiguracja: Compose działa bez tokenu bota, a decyzja o fallbacku zdjęcie → tekst korzysta ze statusu 400 zamiast treści błędu, z zachowaniem kolejki i ponowień. Poprawiono FAQ o metadanych urządzeń oraz przykładowe zmienne i dokumentację, w tym minimum retencji 2 i różnice między aplikacją a Compose.
- Zależności: akcje GitHub przypięto do pełnych SHA, a oba etapy obrazu Node 22 bookworm-slim do tego samego digestu wieloplatformowego. Dodano cotygodniowe aktualizacje Dependabota dla akcji i Dockera, z blokadą zmiany głównej wersji Node. npm w obrazie runtime zaktualizowano do 12.2.2, usuwając blokujące wyniki skanu w jego zależnościach.
- Publikacja obrazów: Trivy skanuje końcowy obraz runtime przed logowaniem do GHCR. HIGH/CRITICAL z dostępną poprawką oraz błędy skanera lub pobrania bazy blokują publikację; pełny JSON pozostaje artefaktem także po odrzuceniu obrazu. Publikowany jest ten sam obraz jako `latest` i SHA, bez ponownego builda. Usunięto nieużywany workflow SSH i opisano ręczną aktualizację przez Portainera.

## 1.1.8 — 2026-11-14

- Zwiększono czytelność ikon rozszerzenia: biały znak z lupą i książkami na pomarańczowym tle, z uproszczonymi detalami.
- Przycisk „Rozszerzenie” ma neutralny wygląd i wyróżnienie tylko na aktywnej stronie. Wylogowanie jest dostępne pod ikoną z etykietą dla czytników ekranu i opisem po najechaniu.
- Dodano subtelny gradient tła panelu w jasnym i ciemnym motywie.

## 1.1.7 — 2026-11-14

- Wprowadzono logo z lupą i książkami w panelu, na ekranie logowania, w favikonie i ikonie skrótu Apple.
- Nagłówek panelu pokazuje wersję aplikacji z `package.json` i link do repozytorium zamiast opisu pod nazwą.
- Rozszerzenie używa nowego logo w popupie, pasku narzędzi, liście rozszerzeń i powiadomieniach. Paczka ZIP zawiera ikony 16, 32, 48 i 128 px.

## 1.1.6 — 2026-10-04

Źródło zmiany manifestu z 1.1.5 na 1.1.6: [e89ecd3](https://github.com/kCn3333/allegro-monitor/commit/e89ecd3fdc224ef5a939ec7e9fc7071e4b2d0053).

- Dodano lokalne ikony SVG Font Awesome w panelu i popupie rozszerzenia, w tym oznaczenia systemów urządzeń, bez pobierania ikon z CDN.
- Paczka rozszerzenia zawiera generowane `popup-icons.js` i informację o licencji ikon CC BY 4.0. Kliknięcie ikony wewnątrz przycisku uruchamia właściwą akcję popupu.

## 1.1.5 — 2026-10-03

Źródło zmiany manifestu z 1.1.4 na 1.1.5: [81a1ce1](https://github.com/kCn3333/allegro-monitor/commit/81a1ce12130a9928de3460bdd14ed280b3746b5c).

- Dodano osobną stronę urządzeń z wersją rozszerzenia, metadanymi systemu i przeglądarki, czasem kontaktu, stanem aktywności i liczbą otwartych kart monitorów. Rozszerzenie przekazuje metadane podczas synchronizacji.
- Panel, urządzenia, FAQ i instalacja rozszerzenia korzystają ze wspólnego układu z nawigacją i przełącznikiem motywu. Strona rozszerzenia udostępnia pobieranie ZIP i generowanie kodu parowania, a lista urządzeń odświeża się co minutę.
- Uzupełnienie z 2026-10-04, nadal przy manifeście 1.1.5 ([a75a475](https://github.com/kCn3333/allegro-monitor/commit/a75a47595bd9edeb604fadae407bfa26aab838a2)): uproszczono karty, dodano zmianę nazw urządzeń i ochronę edycji przed odświeżaniem; usunięto zapisywanie i pokazywanie IP urządzeń.

## 1.1.4 — 2026-09-29

- Adres backendu pochodzi z `APP_PUBLIC_URL` w `.env` lub środowisku kontenera. Serwer generuje paczkę rozszerzenia i uprawnienia domeny przy starcie.
- Usunięto adres instalacji z kodu rozszerzenia. Popup wyświetla konfigurację paczki; zmiana serwera wymaga ponownego parowania bez przekazywania starego tokena.
- ZIP zawiera wyłącznie jawnie wskazane zasoby oraz publiczny adres. Obraz działa z systemem plików tylko do odczytu i katalogiem `/tmp`.

## Backend — 2026-09-29

- Zaktualizowano Fastify i zależności fast-uri do wersji z poprawkami bezpieczeństwa; CI sprawdza podatności zależności produkcyjnych.
- Panel pokazuje sparowane urządzenia i umożliwia odwołanie jednego lub wszystkich tokenów, bez usuwania wspólnych monitorów. Odwołanie wszystkich usuwa też oczekujące kody parowania.
- Poprawiono FAQ dotyczące blokady logowania i udokumentowano wybór adresu backendu przez rozszerzenie.
- Ujednolicono wspólne kolumny zapytań monitorów i usunięto nieużywane dane diagnostyczne oraz zmienną testową. Historyczne kolumny i migracje pozostają obsługiwane.

## 1.1.2 — niewydane (wpis historyczny)

Wpis i manifest z wersją 1.1.2 dodano 2026-09-09 w [a7ccb32](https://github.com/kCn3333/allegro-monitor/commit/a7ccb3202ccc8a1c2b4ee2f2bd661942c5c10f4d), a zmiany scalono tego dnia przez [PR #4](https://github.com/kCn3333/allegro-monitor/pull/4). Zachowano historyczną etykietę „niewydane”: nie potwierdzono osobnego wydania 1.1.2 tagiem ani GitHub Release. Poniższe zmiany są już w historii `main`; wpis nie oznacza oczekujących prac.

- Usunięto nieużywany harmonogram backendu oraz funkcje wywoływane wyłącznie przez testy. Historyczna kolumna `next_check_at` pozostaje zgodna z istniejącymi bazami; harmonogram prowadzi rozszerzenie.
- Każda próba w `checkDue()` kończy się pojedynczym zapisem `finishAttempt()`, przed zgłoszeniem błędu lub przerwaniem cyklu.
- Usunięto niepodłączony skrypt `allegro_auth.py` i ustawienia `ALLEGRO_*`. Testy dostarczania i obecności używają ścieżek stosowanych przez aplikację.

## 1.1.1 — 2026-09-07

[PR #3](https://github.com/kCn3333/allegro-monitor/pull/3)

- Harmonogram po błędzie jest utrwalany przed przerwaniem cyklu przez captcha lub zwróceniem błędu ręcznego sprawdzania, także przy niedostępnym backendzie.
- Próba ma trwały identyfikator i termin odzyskania (minimum 10 minut lub interwał monitora). Restart workera nie uruchamia natychmiast ponownego odczytu; inne wymagalne monitory mogą działać.
- Po przyjęciu wyników harmonogram jest zapisywany przed podświetleniem i synchronizacją powiadomień; ich awarie nie zmieniają udanego sprawdzenia w błąd odczytu.
- Etykieta „Nowa” wynika z cyklu sprawdzenia, niezależnie od rozdzielczości zegara. Migracja zachowuje dane, liczniki i punkt odniesienia, zerując wyłącznie niejednoznaczne historyczne etykiety.

## 1.1.0 — 2026-09-07

[PR #2](https://github.com/kCn3333/allegro-monitor/pull/2)

- Dokładne dopasowanie adresu karty wraz z filtrami i ponowna kontrola przed zapisem wyników.
- Serializowane zapisy stanu rozszerzenia i synchronizacje, bez nadpisywania nowych ustawień przez zakończone sprawdzanie.
- Trwałe partie powiadomień z ACK, deduplikacja po czyszczeniu listy i odbiór niezależny dla urządzeń; zgodność ze starszym protokołem.
- Transakcyjna kolejka Telegrama z osobnymi statusami odbiorców, timeoutami, ponowieniami i odzyskiwaniem po restarcie.
- Blokada logowania sprawdzana przed hasłem, limit pamięci i nagłówek Retry-After.
- Widoczny stan łączności i czas synchronizacji; ręczne sprawdzanie niezależne od wyciszenia.
- Migracja zachowująca istniejące dane; najpierw aktualizacja backendu, potem rozszerzenia.
- Testy mechanizmów backendu i rozszerzenia na mockach oraz istniejącym schemacie SQLite.

## Backend — 2026-08-31

- Zastąpiono Basic Auth formularzem logowania i trwałymi sesjami SQLite; „Zapamiętaj mnie” utrzymuje odnawianą sesję przez 30 dni.
- Tokeny sesji są przechowywane jako hashe. Wylogowanie unieważnia sesję, a zmiana danych logowania lub sekretu unieważnia wszystkie sesje panelu.
- Dodano wymagany w produkcji `APP_SESSION_SECRET` oraz cookies `HttpOnly`, `SameSite=Strict` i `Secure` w produkcji.
- Dodano spersonalizowane powitanie i poprawiono jego wyśrodkowanie na stronie logowania.

## 1.0.2 — 2026-08-20

- Puste wyniki wyszukiwania są traktowane jako poprawne sprawdzenie z zerową
  liczbą ofert, a nie jako błąd odczytu.
- Oferty z sekcji „Rekomendacje dla Ciebie” i „Znaleźliśmy podobne oferty” nie
  trafiają do monitorowania ani powiadomień.

## 1.0.1 — 2026-08-05

- Dodano stabilny, wewnętrzny obszar przewijania dla długich list monitorów i
  nowych ofert.
- Nagłówek aktywnej listy pozostaje widoczny podczas przewijania.

## 1.0.0 — 2026-08-05

- Popup rozszerzenia podzielono na zakładki: Monitor, Obserwowane i Nowe.
- Zakładka główna porównuje lokalną wersję z paczką publikowaną przez serwer.
- Ustawienie powiadomień ma formę wyraźnego przełącznika przy każdym monitorze.
- Każdy monitor ma osobne akcje otwarcia karty i ręcznego sprawdzenia; ręczne
  sprawdzenie jest niedostępne po wyciszeniu powiadomień lub zamknięciu karty.
- Zakładka Nowe pokazuje licznik i listę ofert odebranych przez dane urządzenie.

## 0.9.0 — 2026-08-05

- Rozdzielono dostarczanie wyników przez otwarte karty od odbierania lokalnych
  powiadomień.
- Nowe oferty są zapisywane jako zdarzenia i przekazywane niezależnie do każdego
  sparowanego rozszerzenia bez duplikatów.
- Każdy monitor ma osobny przełącznik powiadomień na każdym urządzeniu.
- Oferta wykryta na jednym komputerze może wywołać powiadomienie na drugim.

## 0.8.0 — 2026-08-05

- Powiadomienie Telegram ma formę karty ze zdjęciem, tytułem, ceną i przyciskiem
  prowadzącym do oferty; w razie odrzucenia zdjęcia używa wariantu tekstowego.
- Serwer i panel WWW są źródłem pełnej listy monitorów, również tych utworzonych
  przed sparowaniem konkretnego rozszerzenia.
- Usuwanie monitora jest dostępne wyłącznie w panelu WWW.
- Dodano pierwszy wariant ustawień rozszerzenia osobno dla urządzenia, rozwinięty
  w wersji 0.9.0 o niezależne powiadomienia.

## 0.7.2 — 2026-08-04

- Numer wersji rozszerzenia jest wyświetlany dynamicznie w popupie.

## 0.7.1 — 2026-08-04

- Dodano ręczny przycisk „Odśwież” pobierający stan monitorów z serwera.
- Dla zamkniętej karty akcję „Sprawdź teraz” zastąpiono akcją „Otwórz kartę”.
- Uporządkowano akcje dostępne przy otwartej i zamkniętej karcie.

## 0.7.0 — 2026-08-04

- Dodano synchronizację monitorów między sparowanymi rozszerzeniami.
- Zmiany nazw, interwałów i stanu monitora są pobierane z serwera.
- Usunięcie monitora w panelu WWW usuwa nieaktualny wpis z rozszerzeń.
- Nowe sparowane urządzenie otrzymuje istniejące monitory, a nowy monitor jest
  przypisywany do sparowanych urządzeń.
- Popup pokazuje liczbę aktywnych urządzeń i pozwala przejść do właściwej karty.
- Panel WWW otrzymał przełączniki aktywności i licznik aktywnych monitorów.
- Przywrócono czytelny, poziomy układ kart monitorów oraz uporządkowano daty i
  statystyki.

## 0.6.3 — 2026-08-04

- Dodano zmianę nazwy monitora z panelu WWW.
- Zmieniono podsumowanie listy na liczbę aktywnych monitorów `N/M`.
- Naprawiono usuwanie starszych lokalnych wpisów z rozszerzenia.

## 0.6.2 — 2026-08-04

- Dodano obsługę skróconych adresów kart działających w tle w Vivaldi.
- Rozszerzenie zachowuje pełny adres wyszukiwania i przywraca go przed
  sprawdzeniem, gdy Vivaldi pokazuje jedynie adres kategorii.

## 0.6.1 — 2026-08-04

- Rozpoznawanie wyszukiwań rozszerzono z `/listing` na strony kategorii Allegro.
- Poprawiono wykrywanie już otwartych kart wyszukiwania.

## 0.6.0 — 2026-08-04

- Dodano FAQ przeznaczone dla użytkowników rozszerzenia.
- Licznik `+N` zaczął oznaczać oferty z ostatniego sprawdzenia zamiast stale
  rosnącej sumy.
- Najnowsze oferty otrzymały subtelne wyróżnienie w panelu.
- Dodano dokładniejsze informacje o stanie i obecności karty.

## 0.5.0 — 2026-08-04

- Dodano heartbeat rozszerzenia i śledzenie otwartej karty osobno dla każdego
  sparowanego urządzenia.
- Monitor pozostaje aktywny, jeśli właściwa karta jest otwarta na przynajmniej
  jednym urządzeniu.
- Panel pokazuje liczbę aktywnych urządzeń oraz stan „Brak otwartej karty”.

## 0.4.1 — 2026-08-04

- Poprawiono wybór zdjęć ofert, aby preferować okładki produktów zamiast ikon i
  elementów interfejsu Allegro.

## 0.4.0 — 2026-08-04

- Dodano interwały 1, 5, 15, 30 i 60 minut.
- Dodano liczniki śledzonych pozycji i wykrytych nowości.
- Wprowadzono retencję ofert znikających z kolejnych wyników wyszukiwania.
- Telegram może wysyłać powiadomienia do wielu dozwolonych czatów.
- Wzmocniono zabezpieczenia panelu, parowania, nagłówków HTTP i kontenera.
- Dodano dokładne wykluczenia konkretnych ofert lub wydań oraz ich obsługę w GUI.
- Naprawiono ochronę żądań formularzy działających za reverse proxy.

## 0.3.0 — 2026-08-03

- Dodano obsługę kart produktowych Allegro, które nie prowadzą bezpośrednio do
  klasycznych adresów `/oferta/...`.
- Rozszerzono wydobywanie identyfikatorów, tytułów, cen i obrazów produktów.

## 0.2.0 — 2026-08-03

- Poprawiono wykrywanie linków ofert w aktualnej strukturze stron Allegro.
- Dodano diagnostykę liczby znalezionych linków i linków rozpoznanych jako
  oferty.

## 0.1.0 — 2026-08-03

- Powstał pierwszy prototyp rozszerzenia Chromium/Vivaldi.
- Dodano parowanie rozszerzenia z prywatnym serwerem.
- Rozszerzenie może zapisać bieżącą kartę wyszukiwania, okresowo ją odświeżać i
  przesyłać znalezione oferty do aplikacji.
- Dodano popup z listą monitorowanych kart i nowych ofert.

## Etap prototypowy przed 0.1.0 — 2026-08-03

- Powstała lekka aplikacja Fastify z bazą ofert, panelem WWW, Telegramem,
  kontenerem i pipeline'em GitHub Actions.
- Przygotowano wdrożenie przez Compose/Portainer oraz obsługę Cloudflare Tunnel.
- Przetestowano monitorowanie po stronie serwera za pomocą Playwright/Chromium,
  Xvfb i noVNC.
- Wariant serwerowej przeglądarki porzucono po blokadach antybotowych Allegro na
  rzecz rozszerzenia korzystającego z prawdziwej sesji użytkownika.
- W repozytorium zachowano również wcześniejszy eksperyment z oficjalnym API
  Allegro i pobieraniem kategorii.
