# Historia zmian

Wersje dotyczą rozszerzenia; osobne wpisy opisują backend. Daty oznaczają dodanie zmian do repozytorium, nie wdrożenie.

## 1.2.2 — 2026-11-18

- Wyszukiwanie kart do sprawdzania i raportowania obecności ograniczone do HTTPS w domenie Allegro i jej subdomenach, bez zmiany parowania i uprawnień.

## 1.2.1 — 2026-11-16

- Czytelne błędy parowania z backendu tekstowego i JSON, bez utraty istniejącego stanu. Aktualizacja nie wymaga ponownego parowania.
- Większe, wyróżnione ceny ofert wyrównane do prawej.

## 1.2.0 — 2026-11-14

- Poprawki interfejsu panelu aplikacji i rozszerzenia.

## 1.1.9 — 2026-11-14

- Worker akceptuje wiadomości tylko od własnego rozszerzenia. Aktualizacja zachowuje parowanie.

## Backend — 2026-11-14

- Wersja nagłówka zgodna z rozszerzeniem, link pod ikoną GitHuba, wyrównanie przycisków kart i usunięcie powtórzonego opisu aplikacji.
- Walidacja danych parowania, nazw monitorów i miniatur; odrzucenie danych bez niepożądanych zmian. Kody parowania: 10 minut ważności, maksymalnie 100 aktywnych kodów.
- Porównywanie poświadczeń przez HMAC, jawne `TRUST_PROXY` i lokalne skrypty panelu bez `unsafe-inline` w `script-src`.
- Opcjonalny Telegram w Compose, fallback zdjęcia według statusu 400, poprawione FAQ i opis konfiguracji.
- Akcje CI przypięte do SHA, obraz Node do digestu; Dependabot i poprawki zależności npm w obrazie.
- Skan Trivy przed publikacją: HIGH/CRITICAL z poprawką oraz błąd skanera blokują publikację; pełny raport JSON pozostaje dostępny. Ręczna aktualizacja przez Portainera zamiast SSH.

## 1.1.8 — 2026-11-14

- Czytelniejsze ikony rozszerzenia, neutralny przycisk „Rozszerzenie”, wylogowanie pod ikoną i subtelny gradient panelu.

## 1.1.7 — 2026-11-14

- Logo z lupą i książkami w panelu, na ekranie logowania i w rozszerzeniu; favikona i ikony skrótów.
- Wersja z `package.json` i link do repozytorium w nagłówku panelu.

## 1.1.6 — 2026-10-04

- Lokalne ikony SVG Font Awesome w panelu i rozszerzeniu, poprawna obsługa kliknięć ikon oraz licencja w ZIP.
- Zmiana manifestu 1.1.5 → 1.1.6: [e89ecd3](https://github.com/kCn3333/allegro-monitor/commit/e89ecd3fdc224ef5a939ec7e9fc7071e4b2d0053).

## 1.1.5 — 2026-10-03

- Strona urządzeń z metadanymi i aktywnością; wspólny układ panelu, FAQ i strony instalacji; pobieranie ZIP i generowanie kodu parowania.
- Zmiana manifestu 1.1.4 → 1.1.5: [81a1ce1](https://github.com/kCn3333/allegro-monitor/commit/81a1ce12130a9928de3460bdd14ed280b3746b5c).
- 2026-10-04, nadal w 1.1.5: prostsze karty, zmiana nazw urządzeń i ochrona edycji przed odświeżaniem; usunięcie zapisywania IP urządzeń ([a75a475](https://github.com/kCn3333/allegro-monitor/commit/a75a47595bd9edeb604fadae407bfa26aab838a2)).

## 1.1.4 — 2026-09-29

- ZIP generowany przy starcie z `APP_PUBLIC_URL`, bez sekretów. Zmiana serwera wymaga nowej paczki i parowania.
- Obraz działa z systemem plików tylko do odczytu i zapisywalnym `/tmp`.

## Backend — 2026-09-29

- Poprawki Fastify i fast-uri, audyt zależności produkcyjnych w CI.
- Odwoływanie urządzeń i kodów bez usuwania monitorów; poprawki FAQ i porządki zapytań bez utraty zgodności bazy.

## 1.1.2 — niewydane (wpis historyczny)

Zmiany dodano i scalono 2026-09-09: [a7ccb32](https://github.com/kCn3333/allegro-monitor/commit/a7ccb3202ccc8a1c2b4ee2f2bd661942c5c10f4d), [PR #4](https://github.com/kCn3333/allegro-monitor/pull/4). Brak potwierdzenia osobnego wydania tagiem lub GitHub Release; wpis nie oznacza oczekujących prac.

- Usunięto nieużywany harmonogram backendu, skrypt `allegro_auth.py` i ustawienia `ALLEGRO_*`; zachowano historyczne `next_check_at`.
- Pojedynczy zapis zakończenia próby przed zgłoszeniem błędu; testy zgodne z używanymi ścieżkami aplikacji.

## 1.1.1 — 2026-09-07

- Trwały harmonogram i identyfikatory prób, odzyskiwanie po restarcie i błędach bez natychmiastowego ponawiania.
- Awaria synchronizacji lub podświetlania nie unieważnia odczytu; etykieta „Nowa” oparta na cyklu sprawdzenia. Migracja zachowuje dane.
- [PR #3](https://github.com/kCn3333/allegro-monitor/pull/3).

## 1.1.0 — 2026-09-07

- Dopasowanie kart z filtrami, serializowane zapisy i synchronizacja; stan łączności i ręczne sprawdzanie niezależne od wyciszenia.
- Partie powiadomień z ACK i deduplikacją; transakcyjna kolejka Telegrama z ponowieniami i odzyskiwaniem po restarcie.
- Limit logowania z `Retry-After`, migracja zachowująca dane i regresje. Aktualizacja: najpierw backend, potem rozszerzenie.
- [PR #2](https://github.com/kCn3333/allegro-monitor/pull/2).

## Backend — 2026-08-31

- Logowanie formularzem i sesje SQLite; „Zapamiętaj mnie” na 30 dni. Hashe tokenów, bezpieczne cookies i wymagany sekret sesji.
- Wylogowanie unieważnia sesję; zmiana danych logowania lub sekretu unieważnia wszystkie. Powitanie na ekranie logowania.

## 1.0.2 — 2026-08-20

- Poprawna obsługa pustych wyników i pomijanie sekcji rekomendacji.

## 1.0.1 — 2026-08-05

- Przewijanie długich list wewnątrz popupu ze stałym nagłówkiem.

## 1.0.0 — 2026-08-05

- Zakładki Monitor, Obserwowane i Nowe; porównywanie wersji i przełączniki powiadomień.
- Akcje kart i lista nowych ofert z licznikiem. W tej wersji ręczne sprawdzanie blokowało wyciszenie lub zamknięcie karty.

## 0.9.0 — 2026-08-05

- Oddzielono sprawdzanie od powiadomień; zdarzenia bez duplikatów dostarczane niezależnie do urządzeń.
- Powiadomienia ustawiane osobno dla każdego monitora i urządzenia.

## 0.8.0 — 2026-08-05

- Telegram: zdjęcie, cena i link, z fallbackiem tekstowym.
- Wspólne monitory z panelu, usuwanie tylko w panelu i pierwsze ustawienia dla urządzeń.

## 0.7.2 — 2026-08-04

- Dynamiczny numer wersji w popupie.

## 0.7.1 — 2026-08-04

- Ręczne odświeżanie i akcje dopasowane do stanu karty.

## 0.7.0 — 2026-08-04

- Synchronizacja wspólnych monitorów, ustawień i usunięć między urządzeniami.
- Licznik aktywnych urządzeń, przejście do karty i uporządkowane karty panelu.

## 0.6.3 — 2026-08-04

- Zmiana nazw w panelu, licznik aktywnych monitorów i usuwanie nieaktualnych wpisów rozszerzenia.

## 0.6.2 — 2026-08-04

- Przywracanie pełnego adresu wyszukiwania przy skróconych adresach kart w tle w Vivaldi.

## 0.6.1 — 2026-08-04

- Wyszukiwania na stronach kategorii i poprawione wykrywanie kart.

## 0.6.0 — 2026-08-04

- FAQ, licznik nowości ostatniego sprawdzenia i wyróżnienia ofert; dokładniejsze stany kart.

## 0.5.0 — 2026-08-04

- Obecność kart osobno dla urządzeń, licznik aktywnych urządzeń i stan „Brak otwartej karty”.

## 0.4.1 — 2026-08-04

- Preferowanie okładek zamiast ikon przy wyborze zdjęć.

## 0.4.0 — 2026-08-04

- Interwały 1–60 minut, liczniki, retencja, wykluczenia i wielu odbiorców Telegrama.
- Zabezpieczenia panelu, parowania i kontenera oraz poprawiona ochrona formularzy za proxy.

## 0.3.0 — 2026-08-03

- Obsługa kart produktowych oraz odczyt ich identyfikatorów, tytułów, cen i obrazów.

## 0.2.0 — 2026-08-03

- Poprawione wykrywanie linków ofert i diagnostyka odczytu.

## 0.1.0 — 2026-08-03

- Prototyp Chromium/Vivaldi: parowanie z serwerem, monitorowanie otwartych wyszukiwań i popup z ofertami.

## Etap prototypowy przed 0.1.0 — 2026-08-03

- Prototyp Fastify, SQLite, panelu, Telegrama i kontenera z CI oraz Compose/Portainer i tunelem.
- Po blokadach antybotowych porzucono przeglądarkę serwerową na rzecz rozszerzenia. Zachowano wcześniejszy eksperyment z API Allegro.
