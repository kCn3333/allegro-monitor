# Praca nad kodem

Wymagania: Node.js 22 (co najmniej **22.16.0**) i program `zip`.

```sh
npm ci
cp .env.example .env
```

Uzupełnij `.env`, następnie uruchom `npm run dev`. Panel domyślnie działa pod `http://localhost:3000`; rozszerzenie wymaga `APP_PUBLIC_URL` z HTTPS. Lokalnie `HOST` i `PORT` sterują nasłuchem, a `DATABASE_PATH` domyślnie wskazuje `./data/monitor.sqlite`.

Minimum wynika z używanego w migracjach [`DatabaseSync.isTransaction`](https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html#databaseistransaction), dostępnego od 22.16.0. Pozostałe używane API SQLite (`DatabaseSync`, `exec`, `prepare`, `close`, `isOpen`, `get/all/run`), `loadEnvFile`, `fetch`, `AbortSignal.timeout` i wymagania zależności w lockfile nie podnoszą tej granicy. Zalecana jest aktualna poprawka linii 22.

`npm run build` czyści wyłącznie wygenerowany `dist` i kompiluje `src/**/*.ts` przez `tsconfig.build.json`, dziedzicząc ustawienia rygoru z `tsconfig.json`. Wynik nadal trafia do `dist/src`, a `npm start` i Docker uruchamiają `dist/src/main.js` z dotychczasowego katalogu roboczego. Testy nie trafiają do obrazu; publiczne assety i pliki rozszerzenia są kopiowane osobno. `npm run check` nadal sprawdza backend i wszystkie testy, również przeglądarkowe.

## Kontrole

```sh
npm run format:check
npm run lint
npm run check
npm run test:coverage
npx playwright install chromium
npm run test:browser
npm run build
```

- `npm run format` formatuje `src/**/*.ts`, `test/**/*.ts`, `public/**/*.js` i `extension/**/*.js`. Styl: 2 spacje, podwójne cudzysłowy, średniki; bez organizowania importów.
- `npm test` uruchamia testy bez pomiaru. `test:coverage` uruchamia ten sam zestaw i mierzy wszystkie pliki backendu `src/**/*.ts`, także niezaładowane. Wyjątek: `src/types.ts` zawiera wyłącznie deklaracje typów. Pomiar nie obejmuje rozszerzenia ani skryptów przeglądarkowych.
- Raporty: `coverage/index.html` i `coverage/lcov.info`; w CI artefakt `backend-coverage-<SHA>`, także po błędzie testów, jeśli raport powstał. Bez wymaganego progu pokrycia.
- Override ograniczony do `c8 → test-exclude` dobiera poprawiony `minimatch` 11 i zgodny `glob` 14; usuwa podatność narzędzi pokrycia bez zmiany zależności produkcyjnych.

Osobna kontrola CI na Node **22.16.0** sprawdza czyste `npm ci`, start i zatrzymanie aplikacji, `/health`, restart watchera po zmianie pliku oraz istniejące testy migracji, rollbacku i ponownego otwarcia bazy. Używa tymczasowych plików i bazy, wolnego portu oraz wyłączonego Telegrama, bez prawdziwego `.env`. Pełny zestaw, w tym Chromium, pozostaje w dotychczasowym zadaniu CI na Node 22.

## Integracja rozszerzenia MV3

`test:browser` obejmuje też rzeczywiście załadowaną paczkę z `/extension/download`: popup, worker, storage, parowanie, wiele kart, odczyt i podświetlanie ofert oraz restart na tym samym profilu. Test używa `launchPersistentContext` z kanałem `chromium`, tymczasowego profilu w trybie deweloperskim i lokalnego backendu. Strony Allegro są syntetyczne; routing i lokalne proxy blokują ruch zewnętrzny. Test nie zastępuje API Chrome ani logiki workera. Sprzątanie zamyka własny kontekst, backend i proxy oraz usuwa profil i bazę, także po błędzie.

Produkcyjna paczka bez `tabs` jest blokująco sprawdzana w CI. Test potwierdza brak uprawnienia w załadowanym manifeście i przez `chrome.permissions.contains`, a także zachowanie tokenu i monitorów po nadpisaniu plików w tym samym katalogu, przeładowaniu przez `chrome.runtime.reload` oraz ponownym uruchomieniu na tym samym profilu.

Test obejmuje Chromium i syntetyczne strony. Popup jest otwierany jako strona `chrome-extension://…/popup.html`, zgodnie z [metodą Playwright](https://playwright.dev/docs/chrome-extensions); test nie automatyzuje przycisku rozszerzenia na pasku narzędzi ani prawdziwej witryny Allegro.

## Publikacja obrazu

[CI](../.github/workflows/ci.yml) sprawdza kod, testy i podatności zależności produkcyjnych. Dla `main` buduje obraz runtime i skanuje go Trivy. HIGH/CRITICAL z dostępną poprawką oraz błędy skanera lub pobrania bazy blokują publikację. Pełny raport wszystkich poziomów, także podatności bez poprawki, trafia do artefaktu `trivy-report-<SHA>`.

Po poprawnym skanie ten sam obraz jest publikowany w GHCR jako `latest` i pełny SHA commita. CI nie wdraża aplikacji.
