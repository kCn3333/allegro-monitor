# Praca nad kodem

Wymagania: Node.js 22, minimum **22.16.0** ze względu na `DatabaseSync.isTransaction`, oraz program `zip`. Używaj aktualnej poprawki linii 22.

Uzupełnij `.env` przed uruchomieniem aplikacji:

```sh
npm ci
cp .env.example .env
npm run dev
```

Panel domyślnie działa pod `http://localhost:3000`; paczka rozszerzenia wymaga `APP_PUBLIC_URL` z HTTPS. Nasłuch ustawiają `HOST` i `PORT`, a baza domyślnie trafia do `./data/monitor.sqlite`.

`npm run build` czyści wygenerowany `dist` i kompiluje wyłącznie backend. `npm start` uruchamia `dist/src/main.js`. Docker zachowuje assety panelu i generuje ZIP z runtime `APP_PUBLIC_URL`; runtime nie zawiera npm/npx.

## Kontrole i testy

```sh
npm run format:check
npm run lint
npm run check
npm run test:coverage
npx playwright install chromium
npm run test:browser
npm run build
npm audit --include=dev --audit-level=low
```

`npm run format` formatuje kod. `check` sprawdza backend i wszystkie testy, w tym przeglądarkowe. `npm test` uruchamia zestaw backendu bez pomiaru pokrycia.

`test:coverage` mierzy wszystkie `src/**/*.ts`, także niezaładowane, poza deklaracjami w `src/types.ts`. Nie obejmuje rozszerzenia ani skryptów przeglądarkowych; brak wymaganego progu. Raporty: `coverage/index.html`, `coverage/lcov.info` i artefakt CI `backend-coverage-<SHA>`, również po błędzie, jeśli powstał raport.

CI sprawdza też minimum Node **22.16.0**: czyste `npm ci`, start, `/health`, restart po zmianie pliku, zamknięcie oraz migracje, rollback i ponowne otwarcie bazy. Próby używają tymczasowych plików, bazy i wolnego portu, bez prawdziwego `.env` i Telegrama.

### Rozszerzenie MV3

`test:browser` sprawdza produkcyjną paczkę z `/extension/download` w rzeczywistym Chromium przez `launchPersistentContext`, z lokalnym backendem i osobnym profilem. Obejmuje parowanie i dodanie aktywnej karty, synchronizację wielu kart, filtrów, paginacji i subdomen, odczyt ofert, odświeżenie i podświetlenie nowych pozycji, zamknięcie i odzyskanie karty oraz zachowanie tokenu i monitorów po przeładowaniu plików i restarcie profilu.

Worker, storage i API Chrome działają bez mocków. Test potwierdza brak `tabs` w załadowanym manifeście i przez `chrome.permissions.contains`. Własne procesy, profil i baza są sprzątane także po błędzie; ruch zewnętrzny jest blokowany.

Ograniczenia: Chromium i syntetyczne strony Allegro. Popup jest otwierany jako strona `chrome-extension://…/popup.html`, bez automatyzacji przycisku na pasku narzędzi i bez kontaktu z prawdziwym Allegro.

## CI i publikacja

[CI](../.github/workflows/ci.yml) sprawdza kod, testy i pełny audyt zależności produkcyjnych oraz deweloperskich. Pull requesty przechodzą pełne kontrole. Push na `main` pomija CI tylko wtedy, gdy wszystkie zmiany dotyczą `README.md`, `CHANGELOG.md` lub `docs/**/*.md`; dodanie innej zmiany uruchamia pełny przebieg.

Po kontrolach push na `main` buduje obraz i skanuje go Trivy. HIGH/CRITICAL z poprawką oraz błędy skanera lub pobrania bazy blokują publikację. Pełny raport wszystkich poziomów trafia do `trivy-report-<SHA>`, także po odrzuceniu obrazu.

Ten sam obraz, bez ponownego builda, jest publikowany w GHCR jako `latest` i pełny SHA commita. Aktualizacja przez Portainera i rollback są ręczne — patrz [procedura operacyjna](operations.md). CI nie wdraża aplikacji.
