# Backup, odtwarzanie i aktualizacja

Polecenia wykonuj na silniku Docker zarządzanym przez Portainera. Korzystają z nazw wolumenów, bez znajomości ich ścieżek na hoście.

## Backup

Poza repozytorium zachowaj konfigurację stosu, zmienne i sekrety oraz SHA commita (`IMAGE_TAG`) i digest obrazu. Kopie przechowuj z ograniczonym dostępem, również poza hostem aplikacji. Sam tag `latest` nie identyfikuje wersji.

1. Ustaw nazwę kontenera z Portainera i przygotuj katalog kopii:

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

2. Zatrzymaj aplikację i sprawdź brak innych kontenerów korzystających z wolumenu:

   ```sh
   docker stop "$APP_CONTAINER"
   test "$(docker inspect --format '{{.State.Running}}' "$APP_CONTAINER")" = false
   test -z "$(docker ps -q --filter volume="$DATA_VOLUME")"
   ```

   Kontynuuj tylko po potwierdzeniu, że żaden proces nie zapisuje bazy, także spoza kontenerów. Do końca kopiowania nie uruchamiaj ani nie aktualizuj stosu.

3. Skopiuj **cały wolumen**, zachowując uprawnienia i UID/GID:

   ```sh
   docker run --rm --network none --user 0:0 \
     --mount "type=volume,src=$DATA_VOLUME,dst=/data,readonly" \
     --mount "type=bind,src=$BACKUP_DIR,dst=/backup" \
     --entrypoint tar "$APP_IMAGE" --numeric-owner -cpf /backup/allegro-monitor-data.tar -C /data . &&
   (cd "$BACKUP_DIR" && sha256sum allegro-monitor-data.tar > allegro-monitor-data.tar.sha256)
   ```

   SQLite używa WAL: nie kopiuj samego aktywnego `monitor.sqlite` ani nie pomijaj pozostałych plików `-wal` i `-shm`.

4. Uruchom `docker start "$APP_CONTAINER"` i sprawdź healthcheck oraz panel. Przywróć pracę aplikacji także po błędzie kopii; niepełne archiwum nie jest backupem.

## Odtworzenie testowe

Użyj obrazu odpowiadającego kopii. Na innym hoście pobierz go po zapisanym SHA lub digeście i ustaw `APP_IMAGE`. Nigdy nie odtwarzaj kopii na działający wolumen.

Sprawdź sumę archiwum; kontynuuj tylko po wyniku poprawnym:

```sh
(cd "$BACKUP_DIR" && sha256sum -c allegro-monitor-data.tar.sha256)
```

Wybierz nową nazwę wolumenu:

```sh
RESTORE_VOLUME="allegro-monitor-restore-$(date -u +%Y%m%dT%H%M%SZ)"
```

Sprawdź `docker volume inspect "$RESTORE_VOLUME"`. Kontynuuj tylko wtedy, gdy wolumen nie istnieje:

```sh
docker volume create "$RESTORE_VOLUME" &&
docker run --rm --network none --user 0:0 \
  --mount "type=volume,src=$RESTORE_VOLUME,dst=/data" \
  --mount "type=bind,src=$BACKUP_DIR,dst=/backup,readonly" \
  --entrypoint tar "$APP_IMAGE" --numeric-owner --same-owner --same-permissions \
  -xpf /backup/allegro-monitor-data.tar -C /data
```

Sprawdź integralność bazy jako domyślny użytkownik obrazu:

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

Oczekiwane: `integrity_check = ok`, brak naruszeń `foreign_key_check`. Po poprawnym wyniku załaduj zachowane dane logowania i sekret do środowiska powłoki z chronionego źródła. Uruchom próbę **bez Telegrama, publicznego tunelu i portów hosta**:

```sh
docker run -d --name allegro-monitor-restore-test --network none \
  --mount "type=volume,src=$RESTORE_VOLUME,dst=/app/data" \
  --env APP_USERNAME --env APP_PASSWORD --env APP_SESSION_SECRET \
  --env APP_PUBLIC_URL=https://restore.example.invalid \
  --env DATABASE_PATH=/app/data/monitor.sqlite \
  --env TELEGRAM_BOT_TOKEN= --env TELEGRAM_CHAT_IDS= --env TELEGRAM_CHAT_ID= \
  "$APP_IMAGE"
```

Po zakończeniu startu sprawdź `/health`:

```sh
docker exec allegro-monitor-restore-test node -e \
  "fetch('http://127.0.0.1:3000/health').then(async r=>{console.log(r.status,await r.text());if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
```

Porównaj dane z kopią: monitory, oferty, wykluczenia, urządzenia i powiązania, sesje, partie ACK oraz kolejkę Telegrama z payloadami, próbami i terminami. Sprawdź niewygasłą sesję, token urządzenia i ponowne pobranie partii przed ACK. Pusty token Telegrama pozostawia kolejkę bez wysyłki.

Po próbie usuń kontener: `docker rm -f allegro-monitor-restore-test`. Wolumen testowy zachowaj do decyzji o odtworzeniu lub usuń po sprawdzeniu jego nazwy.

## Aktualizacja i rollback w Portainerze

1. Wykonaj backup. Przetestuj nowy obraz na osobnej kopii wolumenu, bez Telegrama i sieci publicznej.
2. Po udanej publikacji w CI ustaw `IMAGE_TAG` na wybrany pełny SHA lub `latest`. Prywatny obraz wymaga dostępu Portainera do `ghcr.io` z prawem odczytu pakietu.
3. Zaktualizuj stos z ponownym pobraniem obrazu, zachowując konfigurację i wolumen. Sprawdź healthcheck, panel i logi.

Rollback wymaga zgodnego **obrazu i kopii bazy**. Po migracji nie uruchamiaj starszego obrazu na zmienionej bazie bez potwierdzenia zgodności. Odtwórz kopię sprzed aktualizacji do nowego wolumenu, przetestuj ją z właściwym obrazem, zatrzymaj aplikację i zmień obraz oraz wolumen w stosie. Zachowaj poprzedni wolumen do potwierdzenia wyniku. Dane wrócą do chwili backupu; wznowienie Telegrama może powtórzyć wiadomości wysłane później.

Schemat SQLite jest wersjonowany przez `PRAGMA user_version`. Wersja `0` oznacza brak numerowania, także w historycznych bazach. Migracja `0→1` zachowuje dotychczasowe reguły; każdy krok jest atomowy. Błąd wycofuje zmiany, umożliwiając ponowienie startu. Zakończone migracje nie są powtarzane, a przyszła wersja blokuje start. Nie zmieniaj numeru ręcznie.

## Zakres sprawdzonej procedury

Próba z 2026-11-14: rootless Podman 6.1.3, Linux amd64, SQLite 3.54.1, obraz z commita `84faf3e0814c8b8d1f13f4e89bc375d0bb1adb1b`. Wyłącznie sztuczne dane i osobne wolumeny, bez sieci i Telegrama; bez testowania interfejsu Portainera ani silnika Docker.

Odtworzono identyczne pliki, uprawnienia i dane wszystkich 9 tabel. Integralność i klucze obce poprawne; działały sesja, tokeny, ponawianie partii i ACK. Kolejka Telegrama pozostała niezmieniona, zadania oczekujące i po wygasłej dzierżawie były dostępne. Healthcheck przeszedł. Produkcja nie była objęta próbą.
