# Praca nad kodem

Wymagania: Node.js 22 (co najmniej 22.5) i program `zip`.

```sh
npm ci
cp .env.example .env
```

Uzupełnij `.env`, następnie uruchom `npm run dev`. Panel domyślnie działa pod `http://localhost:3000`; rozszerzenie wymaga `APP_PUBLIC_URL` z HTTPS. Lokalnie `HOST` i `PORT` sterują nasłuchem, a `DATABASE_PATH` domyślnie wskazuje `./data/monitor.sqlite`.

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

## Publikacja obrazu

[CI](../.github/workflows/ci.yml) sprawdza kod, testy i podatności zależności produkcyjnych. Dla `main` buduje obraz runtime i skanuje go Trivy. HIGH/CRITICAL z dostępną poprawką oraz błędy skanera lub pobrania bazy blokują publikację. Pełny raport wszystkich poziomów, także podatności bez poprawki, trafia do artefaktu `trivy-report-<SHA>`.

Po poprawnym skanie ten sam obraz jest publikowany w GHCR jako `latest` i pełny SHA commita. CI nie wdraża aplikacji.
