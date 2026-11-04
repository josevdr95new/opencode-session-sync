# opencode-session-sync

Respalda y restaura tus sesiones y configuración de OpenCode, en local o GitHub · cifrado AES-256-GCM · cero dependencias.

---

## Inicio rápido

```text
npx opencode-session-sync setup
npx opencode-session-sync backup
```

Listo. `setup` no hace preguntas (usa el proveedor local) y genera una frase de cifrado automáticamente:

```text
✓ Configuración guardada en C:\Users\TÚ\.config\opencode\sync.json
Proveedor: local · destino de copias: C:\Users\TÚ\.config\opencode\sync-backup · partes: 80mb · cifrado: sí
✓ Frase de cifrado generada y guardada en C:\Users\TÚ\.config\opencode\sync-auth.json (no se vuelve a mostrar)
✓ Respaldo creado: 3 archivo(s), 520 B sin comprimir · 1 parte(s) de 512 B · cifrado: AES-256-GCM · sha256 3f2a91c0b8d4…
→ Guardado en: C:\Users\TÚ\.config\opencode\sync-backup\20261030T183547Z
```

Para restaurar en esta misma máquina:

```text
npx opencode-session-sync restore --overwrite
```

Sin `--overwrite` el restore es seguro: solo muestra lo que haría y no toca los archivos existentes.

## Cómo funciona

- **Qué copia**: toda tu configuración de OpenCode (`opencode.jsonc`, `agent/`, `command/`, `plugin/`, `skills/`, …) y los datos del `data dir` (`opencode.db` + `storage/` completo).
- **Dónde queda cada copia**: en una carpeta con marca de tiempo dentro de `<configDir>\sync-backup\`, p. ej. `20261030T183547Z`.
- **Cómo viaja**: cada copia tiene un `manifest.json` + trozos `part.000`, `part.001`, … (por defecto 80 MiB por parte; configurable con `setup --parts 1.5gb`, por ejemplo).
- **Cifrado**: AES-256-GCM + scrypt, encendido por defecto. Checksum sha256 verificado al restaurar. Las rutas peligrosas son rechazadas.
- **La frase de cifrado** se guarda en `<configDir>\sync-auth.json` y no se vuelve a mostrar. **Si la pierdes, pierdes los respaldos cifrados** — respáldala aparte (p. ej. en tu gestor de contraseñas).

**IMPORTANTE — passphrase**: guarda el contenido de `sync-auth.json` en tu gestor de contraseñas. Es la única forma de descifrar tus respaldos si se pierde el archivo junto con el disco.

## Restaurar (otra máquina)

Con el proveedor local, copia a mano la carpeta de la copia (los `part.000…` + `manifest.json`) a la nueva máquina — llámala `sync-artifacts` — y luego:

```text
npm install -g opencode-session-sync
opencode-session-sync setup
opencode-session-sync restore --from C:\ruta\a\sync-artifacts --overwrite
```

«¿Por qué no restaurar solo?» — sin `--overwrite`, un restore sobre archivos existentes se queda en modo seguro (te muestra el plan). Con `--overwrite` escribe.

Espera a que OpenCode **no esté corriendo** antes de restaurar: escribe `opencode.db` directamente.

## GitHub (opcional)

Alternativa al proveedor local: tus copias viven en un repo **privado** de GitHub y se suben/bajan con `git` (CLI).

Requisitos:

- `git` instalado y en el PATH.
- Un token de acceso personal (PAT) *fine-grained* con **Contents: Read/Write** sobre el repo destino.
- Repo privado creado de antemano.

```text
npx opencode-session-sync setup --provider github --owner miusuario --repo opencode-sessions --token ghp_xxxxxxxxxxxx
npx opencode-session-sync backup
npx opencode-session-sync restore --overwrite
```

El token se usa en la URL de git durante la operación y se limpia después; nunca queda en la config de git ni en `sync.json`.

**Nota de tamaño**: la base de datos de OpenCode puede pesar >1.5 GB. Con el default de 80 MiB por parte se sube en trozos — ningún archivo individual supera el límite de **100 MiB por archivo** de GitHub. Si prefieres partes más grandes, recuerda ese límite.

## Comandos CLI

| Comando | Qué hace |
|---|---|
| `setup` | Detecta tus dirs, guarda `sync.json` y genera passphrase para `sync-auth.json` |
| `backup` | Crea una copia troceada y cifrada en `<configDir>\sync-backup\<stamp>\` (o la sube al repo GitHub configurado) |
| `restore` | Restaura la copia más reciente o la de `--from`; seguro por defecto (dry-run implícito) |
| `status` | Rutas detectadas, proveedor, última copia, cifrado y credenciales |

Opciones comunes:

| Opción | Para qué |
|---|---|
| `--lang es\|en` | Idioma de los mensajes (default: es) |
| `--provider local\|github` | Proveedor a usar |
| `--dry-run` | Simula la operación sin escribir |
| `--overwrite` | En `restore`: sobreescribe archivos existentes |
| `--no-encrypt` | Desactiva el cifrado SOLO en esa copia |
| `--output <dir>` | En `backup` local: carpeta destino alternativa |
| `--from <dir>` | En `restore`: carpeta con `manifest.json` + `part.*` |
| `--parts <tamaño>` | Ej. `80mb`, `1.5gb`, `512kb` o bytes (default 80 MiB) — se fija en setup |
| `--owner X --repo Y --token T` | Credenciales del repo GitHub (para `setup`) |

## Comandos del plugin OpenCode

Instalación: copia este package (o enlázalo) en `~/.config/opencode/plugins/opencode-session-sync/` — o a nivel de proyecto, `.opencode/plugins/`.

| Comando | Qué hace |
|---|---|
| `/sync-setup [google\|github]` | Muestra la guía de configuración del proveedor elegido |
| `/sync-login` | Estado simple de credenciales (`sync-auth.json`) |
| `/sync-logout` | Acción sobre las credenciales locales |
| `/sync-status` | Igual que `status` del CLI |
| `/sync-now` | Igual que `backup` del CLI |
| `/sync-restore` | Igual que `restore` del CLI; admite `--from=<dir>` y `--overwrite` |
| `/sync-help` | Lista los comandos del plugin |

En OpenCode, ojo: los comandos del plugin comparten el mismo motor real que la CLI (mismos mensajes y mismas reglas de cifrado), así que lo que respaldan y restauran es idéntico.

## Configuración

`<configDir>\sync.json` con el aspecto real:

```json
{
  "provider": "local",
  "localDir": "C:\\Users\\TÚ\\.config\\opencode\\sync-backup",
  "parts": "80mb",
  "encrypt": true
}
```

Si usas el proveedor github se añaden `owner` y `repo`. También puedes forzar rutas con variables de entorno:

```text
OPENCODE_DATA_DIR       # sobreescribe el data dir (%USERPROFILE%\.local\share\opencode)
OPENCODE_CONFIG_DIR     # sobreescribe el config dir (%USERPROFILE%\.config\opencode)
OPENCODE_LANG           # es | en
OPENCODE_SYNC_PASSPHRASE  # passphrase sin escribir en disco (útil en scripts)
OPENCODE_SYNC_TOKEN       # token GitHub sin escribirlo en disco
```

## Privacidad y seguridad

- El cifrado va **encendido** por defecto: un respaldo sin passphrase no sube (la CLI falla con mensaje claro, no baja a texto plano).
- `sync-auth.json` (la passphrase) **nunca entra en los respaldos** — está excluido explícitamente.
- Tampoco viajan `sync.json`, `node_modules`, `.git` ni la propia carpeta `sync-backup`.
- Con GitHub, el token solo vive en la URL de `git push`/`git fetch` mientras corre la operación; la salida del proceso se reescribe sustituyéndolo por `***`.

## Limitaciones honestas

- **Copia en caliente**: OpenCode abierto mientras respalda funciona; lo que NO se respalda es `opencode.db-wal` ni `opencode.db-shm` (inconsistentes mientras el proceso usa la db).
- **Base de datos grande**: si tu `opencode.db` pesa mucho, la operación es lineal en tamaño (lenta en laptops antiguas, disco lleno, etc.).
- **Límite de GitHub**: 100 MiB por archivo individual; con partes de 80 MiB ocurre solo si forcibly subes partes más grandes que eso.
- **Google Drive NO está incluido en v0.2.0**: `/sync-setup google` muestra una ayuda de configuración, pero no existe un proveedor que suba a Google Drive.
- **Restore pisa con **`--overwrite`**`: siempre muestra un dry-run antes sin esa opción; lee la salida.

## Tests y compatibilidad

```text
npm test
```

29 tests, cero dependencias. Requiere **Node ≥ 18**. Funciona en Windows, macOS y Linux.

## Estado y licencia

- **v0.2.0**: estable y testeada (29/29 tests en verde). CLI + plugin con acciones reales, proveedores local y GitHub, cifrado AES-256-GCM, i18n es/en.
- Licencia: **MIT**.

---
---

# opencode-session-sync (English)

Back up and restore your OpenCode sessions and configuration, locally or to GitHub · AES-256-GCM encryption · zero dependencies.

---

## Quick start

```text
npx opencode-session-sync setup
npx opencode-session-sync backup
```

That's it. `setup` asks nothing (uses the local provider) and generates an encryption passphrase automatically:

```text
✓ Config saved in C:\Users\YOU\.config\opencode\sync.json
Provider: local · backup dir: C:\Users\YOU\.config\opencode\sync-backup · parts: 80mb · encryption: on
✓ Passphrase generated and saved in C:\Users\YOU\.config\opencode\sync-auth.json (not shown again)
✓ Backup created: 3 file(s), 520 B uncompressed · 1 part(s) of 512 B · encryption: AES-256-GCM · sha256 3f2a91c0b8d4…
→ Saved in: C:\Users\YOU\.config\opencode\sync-backup\20261030T183547Z
```

To restore on this same machine:

```text
npx opencode-session-sync restore --overwrite
```

Without `--overwrite`, restore is safe: it only shows what it would do and never touches existing files.

## How it works

- **What it copies**: your entire OpenCode configuration (`opencode.jsonc`, `agent/`, `command/`, `plugin/`, `skills/`, …) and the data directory (`opencode.db` + the full `storage/` tree).
- **Where each backup goes**: a timestamped folder inside `<configDir>\sync-backup\`, e.g. `20261030T183547Z`.
- **How it travels**: each backup is a `manifest.json` + chunks `part.000`, `part.001`, … (default 80 MiB per part; configurable via `setup --parts 1.5gb`).
- **Encryption**: AES-256-GCM + scrypt, on by default. sha256 checksum verified on restore. Dangerous paths are rejected.
- **The passphrase** is stored in `<configDir>\sync-auth.json` and is never shown again. **If you lose it, you lose your encrypted backups** — back it up separately (e.g. in your password manager).

**IMPORTANT — passphrase**: keep the contents of `sync-auth.json` in your password manager. It is the only way to decrypt your backups if the file is lost along with the disk.

## Restore (another machine)

With the local provider, manually copy the backup folder (the `part.000…` files + `manifest.json`) to the new machine — call it `sync-artifacts` — then:

```text
npm install -g opencode-session-sync
opencode-session-sync setup
opencode-session-sync restore --from C:\path\to\sync-artifacts --overwrite
```

"Why not just restore?" — without `--overwrite`, a restore over existing files stays in safe mode (it shows the plan). With `--overwrite` it writes.

Make sure OpenCode is **not running** before restoring: it writes `opencode.db` directly.

## GitHub (optional)

Alternative to the local provider: your backups live in a **private** GitHub repo, uploaded/downloaded with `git` (CLI).

Requirements:

- `git` installed and on PATH.
- A *fine-grained* personal access token (PAT) with **Contents: Read/Write** on the target repo.
- A private repo created in advance.

```text
npx opencode-session-sync setup --provider github --owner myuser --repo opencode-sessions --token ghp_xxxxxxxxxxxx
npx opencode-session-sync backup
npx opencode-session-sync restore --overwrite
```

The token is used in the git URL during the operation and cleaned up afterwards; it never lands in git config or `sync.json`.

**Size note**: the OpenCode database can weigh more than 1.5 GB. With the 80 MiB default it uploads in chunks — no single file exceeds GitHub's **100 MiB per file** limit. If you prefer larger parts, keep that limit in mind.

## CLI commands

| Command | What it does |
|---|---|
| `setup` | Detects your dirs, saves `sync.json` and generates a passphrase in `sync-auth.json` |
| `backup` | Creates an encrypted, chunked backup into `<configDir>\sync-backup\<stamp>\` (or pushes to the configured GitHub repo) |
| `restore` | Restores the latest backup or the one at `--from`; safe by default (implicit dry-run) |
| `status` | Detected paths, provider, last backup, encryption, credentials |

Common options:

| Option | Purpose |
|---|---|
| `--lang es\|en` | Message language (default: es) |
| `--provider local\|github` | Which provider to use |
| `--dry-run` | Simulate without writing |
| `--overwrite` | On `restore`: overwrite existing files |
| `--no-encrypt` | Disable encryption for THAT backup only |
| `--output <dir>` | On `backup` (local): alternative destination folder |
| `--from <dir>` | On `restore`: folder with `manifest.json` + `part.*` |
| `--parts <size>` | e.g. `80mb`, `1.5gb`, `512kb` or bytes (default 80 MiB) — set at setup |
| `--owner X --repo Y --token T` | GitHub repo credentials (for `setup`) |

## OpenCode plugin commands

Installation: copy (or link) this package into `~/.config/opencode/plugins/opencode-session-sync/` — or per-project, `.opencode/plugins/`.

| Command | What it does |
|---|---|
| `/sync-setup [google\|github]` | Shows the setup guide for the chosen provider |
| `/sync-login` | Simple credential status (`sync-auth.json`) |
| `/sync-logout` | Acts on local credentials |
| `/sync-status` | Same as the `status` CLI command |
| `/sync-now` | Same as the `backup` CLI command |
| `/sync-restore` | Same as the `restore` CLI command; accepts `--from=<dir>` and `--overwrite` |
| `/sync-help` | Lists the plugin commands |

Note: the plugin commands share the exact same real engine as the CLI (same messages, same encryption rules), so what they back up and restore is identical.

## Configuration

`<configDir>\sync.json` with its real look:

```json
{
  "provider": "local",
  "localDir": "C:\\Users\\YOU\\.config\\opencode\\sync-backup",
  "parts": "80mb",
  "encrypt": true
}
```

With the GitHub provider, `owner` and `repo` are added. You can also override paths with environment variables:

```text
OPENCODE_DATA_DIR         # overrides the data dir (%USERPROFILE%\.local\share\opencode)
OPENCODE_CONFIG_DIR       # overrides the config dir (%USERPROFILE%\.config\opencode)
OPENCODE_LANG             # es | en
OPENCODE_SYNC_PASSPHRASE  # passphrase without writing it to disk (useful in scripts)
OPENCODE_SYNC_TOKEN       # GitHub token without writing it to disk
```

## Privacy and security

- Encryption is **on** by default: a backup without a passphrase fails with a clear message, it never falls back to plaintext.
- `sync-auth.json` (the passphrase) is **never included in backups** — explicitly excluded.
- Neither are `sync.json`, `node_modules`, `.git` or the local `sync-backup` folder itself.
- With GitHub, the token only lives in the `git push`/`git fetch` URL while the operation runs; the process output rewrites it as `***`.

## Honest limitations

- **Hot database**: using OpenCode while backing up works; what is NOT backed up is `opencode.db-wal` and `opencode.db-shm` (inconsistent while the process uses the db).
- **Large database**: if your `opencode.db` is heavy, the operation is linear in size (slow on old laptops, full disks, etc.).
- **GitHub limit**: 100 MiB per individual file; with 80 MiB parts it only matters if you force larger parts.
- **Google Drive is NOT included in v0.2.0**: `/sync-setup google` shows a setup guide, but no provider actually uploads to Google Drive.
- **Restore overwrites with `--overwrite`**: without that option it always shows a dry-run first; read the output.

## Tests and compatibility

```text
npm test
```

29 tests, zero dependencies. Requires **Node ≥ 18**. Works on Windows, macOS and Linux.

## Status and license

- **v0.2.0**: stable and tested (29/29 tests green). CLI + plugin with real actions, local and GitHub providers, AES-256-GCM encryption, i18n es/en.
- License: **MIT**.
