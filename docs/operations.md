# Backup, odtwarzanie i aktualizacja przez Portainera

Procedura dotyczy dostarczonego Compose i wolumenu `allegro-monitor-data`. Polecenia Docker wykonuj na tym samym silniku, którym zarządza Portainer. Nie wymagają znajomości fizycznej ścieżki wolumenu na hoście.

## Co zachować

Poza repozytorium przechowuj konfigurację stosu, jego zmienne i sekrety, w tym `APP_USERNAME`, `APP_PASSWORD`, `APP_SESSION_SECRET`, ustawienia Telegrama oraz publicznego adresu i proxy. Zapisz pełny SHA commita użytego jako `IMAGE_TAG` i digest odpowiadającego mu obrazu. Sam tag `latest` nie identyfikuje wersji kopii. Kopię bazy i konfigurację przechowuj z ograniczonym dostępem, najlepiej zaszyfrowane, również poza hostem aplikacji.

SQLite działa w trybie WAL. Nie kopiuj samego aktywnego `monitor.sqlite` i nie usuwaj plików `-wal` ani `-shm`. Kopia obejmuje **cały zatrzymany wolumen**, również te pliki, jeśli pozostały po zatrzymaniu. [Opis WAL w SQLite](https://sqlite.org/wal.html#the_wal_file).

## Ręczny backup

1. W Portainerze ustal nazwę kontenera aplikacji. Przygotuj prywatny katalog kopii poza repozytorium i zapisz identyfikatory aktualnego obrazu:

   ```sh
   APP_CONTAINER='nazwa-kontenera-z-Portainera'
   DATA_VOLUME=allegro-monitor-data
   BACKUP_DIR="$HOME/backups/allegro-monitor/$(date -u +%Y%m%dT%H%M%SZ)"
   mkdir -p "$BACKUP_DIR"
   chmod 700 "$BACKUP_DIR"
   APP_IMAGE="$(docker inspect --format '{{.Image}}' "$APP_CONTAINER")"
   docker inspect --format '{{.Config.Image}} {{.Image}}' "$APP_CONTAINER" > "$BACKUP_DIR/image.txt"
   docker image inspect --format '{{json .RepoDigests}}' "$APP_IMAGE" >> "$BACKUP_DIR/image.txt"
   ```

   Lokalny ID obrazu nie jest SHA commita; SHA zachowaj ze stosu lub powiązanego przebiegu CI. Na innym hoście pobierz ten sam obraz po zapisanym SHA/digeście i ustaw odpowiednio `APP_IMAGE`.

2. Zatrzymaj kontener przyciskiem **Stop** w Portainerze lub poleceniem poniżej. Potwierdź zatrzymanie i brak innych działających kontenerów korzystających z wolumenu:

   ```sh
   docker stop "$APP_CONTAINER"
   test "$(docker inspect --format '{{.State.Running}}' "$APP_CONTAINER")" = false
   test -z "$(docker ps -q --filter volume="$DATA_VOLUME")"
   ```

   Potwierdź także brak zapisujących procesów poza kontenerami: narzędzi SQLite, skryptów administracyjnych i innych usług z dostępem do danych. Sam pusty wynik `docker ps` tego nie dowodzi. Nie rozpoczynaj kopii, dopóki wszystkie procesy zapisujące bazę nie są zatrzymane; w czasie kopiowania nie aktualizuj ani nie uruchamiaj stosu.

3. Wykonaj archiwum całego wolumenu przez kontener pomocniczy z tego samego obrazu. Źródło jest montowane tylko do odczytu; `tar` zachowuje numeryczne UID/GID i uprawnienia:

   ```sh
   docker run --rm --network none --user 0:0 \
     --mount "type=volume,src=$DATA_VOLUME,dst=/data,readonly" \
     --mount "type=bind,src=$BACKUP_DIR,dst=/backup" \
     --entrypoint tar "$APP_IMAGE" --numeric-owner -cpf /backup/allegro-monitor-data.tar -C /data . &&
   (cd "$BACKUP_DIR" && sha256sum allegro-monitor-data.tar > allegro-monitor-data.tar.sha256)
   ```

4. Po zakończeniu kopiowania uruchom aplikację przez **Start** lub `docker start "$APP_CONTAINER"` i sprawdź healthcheck oraz panel. Także po błędzie archiwizacji przywróć pracę zatrzymanej aplikacji; nie traktuj niekompletnego archiwum jako backupu.

## Odtworzenie najpierw do osobnego wolumenu

Użyj obrazu powiązanego z kopią i nowej, nieużywanej nazwy wolumenu. Nie nadpisuj działającego wolumenu ani nie nakładaj archiwum na istniejącą bazę.

```sh
(cd "$BACKUP_DIR" && sha256sum -c allegro-monitor-data.tar.sha256)
```

Kontynuuj tylko po poprawnej weryfikacji sumy. Przed utworzeniem wolumenu upewnij się, że wybrana nazwa jeszcze nie istnieje (`docker volume inspect NAZWA`):

```sh
RESTORE_VOLUME="allegro-monitor-restore-$(date -u +%Y%m%dT%H%M%SZ)"
docker volume create "$RESTORE_VOLUME" &&
docker run --rm --network none --user 0:0 \
  --mount "type=volume,src=$RESTORE_VOLUME,dst=/data" \
  --mount "type=bind,src=$BACKUP_DIR,dst=/backup,readonly" \
  --entrypoint tar "$APP_IMAGE" --numeric-owner --same-owner --same-permissions \
  -xpf /backup/allegro-monitor-data.tar -C /data
```

Przed uruchomieniem sprawdź SQLite na odtworzonym wolumenie, jako domyślny użytkownik `node`:

```sh
docker run --rm --network none \
  --mount "type=volume,src=$RESTORE_VOLUME,dst=/app/data" \
  --entrypoint node "$APP_IMAGE" --experimental-sqlite --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/app/data/monitor.sqlite");
const integrity = db.prepare("PRAGMA integrity_check").all();
const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
console.log({ integrity, foreignKeys });
db.close();
if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" || foreignKeys.length) process.exit(1);
'
```

Oczekiwany wynik: `integrity_check = ok` i pusta lista `foreign_key_check`. Następnie załaduj zachowane `APP_USERNAME`, `APP_PASSWORD` i `APP_SESSION_SECRET` do środowiska powłoki z chronionego źródła. Uruchom próbę bez Telegrama, portów hosta i publicznego tunelu:

```sh
docker run -d --name allegro-monitor-restore-test --network none \
  --mount "type=volume,src=$RESTORE_VOLUME,dst=/app/data" \
  --env APP_USERNAME --env APP_PASSWORD --env APP_SESSION_SECRET \
  --env APP_PUBLIC_URL=https://restore.example.invalid \
  --env DATABASE_PATH=/app/data/monitor.sqlite \
  --env TELEGRAM_BOT_TOKEN= --env TELEGRAM_CHAT_IDS= --env TELEGRAM_CHAT_ID= \
  "$APP_IMAGE"
```

Po zakończeniu startu sprawdź healthcheck (błąd oznacza, że próba wymaga wyjaśnienia):

```sh
docker exec allegro-monitor-restore-test node -e \
  "fetch('http://127.0.0.1:3000/health').then(async r=>{console.log(r.status,await r.text());if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
```

Adres `.invalid` jest wyłącznie testową wartością wymaganą przez konfigurację produkcyjną. `--network none` i brak publikacji portów izolują próbę; dostęp do API wykonuj przez `docker exec`. Pusty token wyłącza worker Telegrama bez usuwania kolejki.

Porównaj z punktem wykonania kopii monitory i ich ustawienia, oferty, wykluczenia, urządzenia i powiązania, hashe tokenów, sesje, zdarzenia i partie ACK oraz pełne zadania Telegrama: odbiorców, payloady, statusy, liczbę prób i terminy. Sprawdź działanie zachowanej, niewygasłej sesji oraz tokenu urządzenia, ponowny odbiór tej samej niepotwierdzonej partii i jednorazowe ACK przypisane do urządzenia. Zmiana danych logowania lub sekretu unieważnia sesje panelu; zachowanie samych rekordów nie wystarczy. Nie włączaj Telegrama w próbie odtworzenia.

Po sprawdzeniu usuń tylko kontener testowy: `docker rm -f allegro-monitor-restore-test`. Wolumen testowy zachowaj do podjęcia decyzji o odtworzeniu albo usuń go świadomie, po upewnieniu się, że nazwa wskazuje wyłącznie próbę.

## Aktualizacja i rollback

Przed aktualizacją wykonaj backup, zachowaj konfigurację i SHA poprzedniego obrazu. Przetestuj nowy obraz na osobnej kopii wolumenu, nadal bez Telegrama i sieci publicznej. W Portainerze ustaw wybrany SHA w `IMAGE_TAG`, pobierz obraz ponownie i zaktualizuj stos. Sprawdź healthcheck, panel i logi; zachowaj poprzednią kopię oraz obraz.

Rollback wymaga **zgodnego zestawu obrazu i kopii bazy**. Po migracji nie uruchamiaj starszego obrazu na zmienionej bazie bez potwierdzenia zgodności. Odtwórz kopię sprzed aktualizacji do nowego wolumenu, przetestuj z odpowiadającym jej obrazem, a dopiero potem zatrzymaj aplikację i zmień w stosie Portainera zarówno obraz, jak i wskazanie wolumenu. Nie usuwaj starego wolumenu przed potwierdzeniem wyniku. Odtworzenie cofa dane do chwili backupu; po ponownym włączeniu Telegrama zadania wysłane po tej chwili mogą spowodować powtórne wiadomości.

## Wykonana próba

Próba z 2026-11-14: rootless Podman 6.1.3 na Linux amd64, obraz zbudowany z commita `84faf3e0814c8b8d1f13f4e89bc375d0bb1adb1b`, SQLite 3.54.1. Użyto dwóch nowych wolumenów, danych syntetycznych, `--network none`, bez portów hosta, tunelu i tokenu Telegrama. Sprawdzono operacje kontenerowe odpowiadające powyższym poleceniom; nie sprawdzano silnika Docker ani interfejsu Portainera.

- Po odtworzeniu pełna zawartość wolumenu, sumy plików, UID/GID i tryby dostępu były identyczne. Aplikacja źródłowa została ponownie uruchomiona po backupie.
- Przed i po starcie odtworzonej aplikacji: `integrity_check = ok`, brak naruszeń `foreign_key_check`, identyczne rekordy wszystkich 9 tabel: 2 monitory, 3 oferty, 1 wykluczenie, 2 urządzenia, 4 powiązania, 1 sesja, 2 zdarzenia, 1 partia ACK i 6 zadań Telegrama.
- Działały zachowana sesja i tokeny urządzeń, ponowne pobranie tej samej partii oraz ACK wyłącznie właściwego urządzenia i tylko raz. Zachowano ustawienia monitorów i wyciszenie urządzenia.
- Bez tokenu kolejka Telegrama pozostała niezmieniona, także payloady, próby i terminy. Osobno, bez wysyłki, potwierdzono odzyskanie zadań oczekujących i z wygasłą dzierżawą. Healthcheck odtworzonej aplikacji przeszedł.

Usunięto wyłącznie testowe kontenery i wolumeny. Próba nie obejmowała produkcji ani rzeczywistych powiadomień Telegrama.
