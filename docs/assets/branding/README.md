# Logo Allegro Monitor

Zaakceptowany znak przedstawia lupę z książkami. Pomarańczowy kolor nawiązuje do interfejsu aplikacji. Pliki są przygotowane do użycia w dokumentacji, panelu i rozszerzeniu.

| Plik | Rozmiar | Przeznaczenie |
| --- | --- | --- |
| `logo-source.png` | 1254 × 1254 px | Oryginał zaakceptowanego logo; źródło pozostałych rozmiarów. |
| `logo-1024.png` | 1024 × 1024 px | Duże materiały graficzne. |
| `logo-512.png` | 512 × 512 px | Ikona aplikacji w wysokiej rozdzielczości. |
| `logo-256.png` | 256 × 256 px | Dokumentacja i materiały graficzne wyświetlane w rozmiarze 128 px. |
| `logo-128.png` | 128 × 128 px | Nagłówek README (48 px), ikona rozszerzenia i powiadomień. |
| `logo-64.png` | 64 × 64 px | Nagłówek panelu i ekran logowania. |
| `logo-48.png` | 48 × 48 px | Lista rozszerzeń przeglądarki. |
| `logo-32.png` | 32 × 32 px | Pasek narzędzi przeglądarki w podwójnej rozdzielczości. |
| `logo-16.png` | 16 × 16 px | Pasek narzędzi przeglądarki. |
| `favicon.ico` | 16, 32 i 48 px | Ikona karty przeglądarki. |
| `apple-touch-icon.png` | 180 × 180 px | Skrót na ekranie urządzeń Apple; białe tło. |

Pozostałe pliki PNG mają przezroczyste tło. Warianty zachowują proporcje i kolory oryginału; są pomniejszone filtrem Lanczos. Nie są grafiką wektorową.

Logo jest używane w głównym README, nagłówku panelu, ekranie logowania, favikonie i ikonie skrótu Apple oraz w oknie, manifeście i powiadomieniach rozszerzenia. Pliki używane przez backend znajdują się w `public/`, a ikony rozszerzenia w `extension/`. Przy zmianie logo należy odświeżyć te kopie. Listę plików dołączanych do ZIP-a określa `src/extension-package.ts`.

Oryginał wygenerowano narzędziem `imagegen`. Dokładny prompt znajduje się w `logo-prompt.txt`.
