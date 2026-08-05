# Historia wydań

Historia została odtworzona na podstawie commitów i kolejnych numerów wersji
rozszerzenia. Wersje `0.x` opisują rozwój prototypu i mogą zawierać zmiany
zarówno rozszerzenia, jak i współpracującej z nim aplikacji serwerowej.

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
