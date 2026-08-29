# Deploying Star Comms to Coolify

Coolify is a self-hosted PaaS that runs Docker workloads on your own
server. This guide takes a fresh Star Comms deployment from empty
Coolify instance to a live fleet.

The bot is unusual for Coolify because it **doesn't serve HTTP
publicly** — it opens outbound UDP to Discord's voice gateways and
exposes only an internal `/healthz` for the healthcheck. You will
never assign it a domain; Coolify's Traefik never routes to it.

## Prerequisites

1. A running Coolify instance (`>=4.0`). Any Docker host with Coolify
   installed and reachable will do.
2. Four Discord applications from the [Developer Portal](https://discord.com/developers/applications)
   with the **Server Members Intent** toggled on. Copy each token — shown
   once. See the main [`README.md`](../README.md) for invite URLs.
3. Your `fleet.yaml` populated with each application's `application_id`.
   Start from [`config/fleet.example.yaml`](../config/fleet.example.yaml).
4. Cue audio (WAV, 48 kHz stereo). Generate placeholders with
   `scripts/gen-cues.sh` or provide real ones — see
   [`cues/README.md`](../cues/README.md).

## Step 1 — Create the resource

Coolify → **+ New Resource** → **Application**.

- Source: **Public Repository** — paste `https://github.com/<owner>/StarComms`.
  For a private repo, choose **Private Repository** and connect the GitHub
  App first.
- Branch: `main`.
- Build Pack: **Docker Compose**.
- Docker Compose Location: **`docker-compose.coolify.yml`**.

That file is deliberately separate from `docker-compose.yml` — the main
compose bind-mounts your local dev tree, which won't exist on the
Coolify host.

## Step 2 — Environment variables

Coolify → your app → **Environment Variables**. Add four secrets:

| Variable | Value |
|---|---|
| `SB_TOKEN_CONTROLLER` | Controller app's bot token |
| `SB_TOKEN_ALFA`       | Relay alfa's token |
| `SB_TOKEN_BRAVO`      | Relay bravo's token |
| `SB_TOKEN_CHARLIE`    | Relay charlie's token |

Mark each as **Is Literal? Yes** and **Is Build Variable? No**. Coolify
will inject them into the container's environment at run time, not
into the image at build time.

## Step 3 — Persistent storage

Coolify → your app → **Persistent Storage** (Storages).

With the Docker Compose build pack Coolify only manages storage that is
**declared in the compose file** — storages added through the UI on a
compose app are not reliably attached. `docker-compose.coolify.yml`
therefore declares everything itself:

| Compose entry | What Coolify does |
|---|---|
| `starcomms-data:/data` | Named volume, auto-created. Holds the SQLite DB. Nothing to do — the image ships `/data` owned by `node`, and Docker copies that ownership onto the empty volume on first mount. |
| `./config/fleet.yaml:/etc/starcomms/fleet.yaml:ro` | Relative **file** bind mount → an editable file entry in Storages. |
| `./cues:/app/cues:ro` | Relative **directory** bind mount → a real host directory. |

Both relative mounts are materialised under
`/data/coolify/applications/<APP_UUID>/` on the host after the first
deploy attempt (the uuid is in the app's URL and in the container name,
`bot-<APP_UUID>`).

### Config

In Storages, open the `fleet.yaml` file entry and paste the contents of
your `fleet.yaml` (built from `config/fleet.example.yaml`). Do **not**
include the bot tokens — they live in env vars, referenced by
`token_env:` names. Save, then **Restart**. No image rebuild required.

If the entry is missing, Coolify has not parsed the compose file yet —
trigger one deploy first, then come back.

### Cues

The cue directory is a host directory bind-mounted at `/app/cues`.
**On every start the container fills in whatever is missing**: the
entrypoint runs `generate-cues.sh` in skip-existing mode (espeak-ng +
ffmpeg are in the image), so a first deploy boots with a complete set
for all four locales and a file that already exists is never touched.

One prerequisite: Coolify creates the host directory as root and the
container runs as `node` (uid 1000). Make it writable once:

```bash
chown -R 1000:1000 /data/coolify/applications/<APP_UUID>/cues
```

then **Restart**. Until that is done the boot log says
`cues: /app/cues is not writable by uid 1000 — skipping generation` and
the fleet starts without cue audio (hails then fail at cue lookup).

**Replacing voices.** Drop your own WAVs (48 kHz stereo; Piper voices
sound warmer than espeak — see `generate.sh`) into the host directory
under the same file names, or `scp -r cues/. <host>:/data/coolify/applications/<APP_UUID>/cues/`.
Existing files win; to force regeneration of a file, delete it and
restart. The spoken lines live at the top of `generate-cues.sh`.

**Manual run.** Coolify → app → **Terminal** → `bot` container:

```bash
./generate-cues.sh                                  # regenerate everything (overwrites)
SKIP_EXISTING=1 LOCALES="da-pirate" ./generate-cues.sh   # only what is missing, one locale
```

Set `GENERATE_CUES=0` in the app's environment to disable the boot-time
step entirely (e.g. when every cue is hand-made).

Expected layout, matching the paths in `fleet.yaml`:

```
cues/
  ring.wav  end.wav
  en/        ready attention busy established disconnected  .wav
  da/        klar  giv_agt   optaget etableret afbrudt      .wav
  en-pirate/ same names as en
  da-pirate/ same names as da
```

Only locales declared under `cue_sets` in `fleet.yaml` are loaded. The
default locale must load or the container will crash-loop; any other
locale that is missing is skipped with a warning and guilds set to it
hear the default locale's audio. Cues are encoded and cached in memory
at boot, so a restart is needed after changing files.

### `SqliteError: unable to open database file`

The process runs as `node` (uid 1000) and cannot write to `/data`.
Happens if the volume was created by an image older than the `/data`
ownership fix, or if Coolify materialised it as a host directory rather
than a named volume. Fix the ownership once, from the host:

```bash
# named volume
docker run --rm -v <APP_UUID>_starcomms-data:/data busybox chown 1000:1000 /data
# or, if it is a bind directory
chown 1000:1000 /data/coolify/applications/<APP_UUID>/data
```

`docker inspect … .Mounts` (below) tells you which of the two you have.

### Checking mounts from inside the container

```bash
# what is actually mounted
docker inspect -f '{{range .Mounts}}{{.Type}}  {{.Source}} -> {{.Destination}}  rw={{.RW}}{{"\n"}}{{end}}' bot-<APP_UUID>

# a shell with the same mounts and env, without starting the bot
cd /data/coolify/applications/<APP_UUID>
docker compose -p <APP_UUID> run --rm --no-deps --entrypoint bash bot
ls -la /etc/starcomms /app/cues /data
```

## Step 4 — Deploy

Coolify → your app → **Deploy**. Watch the build log — the first build
is ~4 minutes because it compiles `@discordjs/opus`, `@snazzah/davey`,
and `better-sqlite3` from source (Debian, never Alpine — musl breaks
the native modules).

The healthcheck starts probing `/healthz` after 60 s. Once green, the
container is registered with Discord and slash commands are live.

Add each bot to your guild with the OAuth URLs in the main README, then
run `/star-comms watch-channel` (and optionally `/star-comms set-language`)
from the controller.

## Updating

Push to `main` → Coolify auto-redeploys (if the webhook is enabled) or
click **Redeploy** in the UI. Env vars and file mounts survive a
redeploy; the SQLite DB survives on the `starcomms-data` volume.

## Rollback / drain

The bot's SIGTERM handler drains open hails cleanly:

```
docker stop --time=30 <container>
```

30 s is enough for the `end` cue on every leg + disconnect. Coolify's
"Stop" button emits SIGTERM by default — safe.

## AGPL compliance

Star Comms is AGPL-3.0. Section 13 requires that users interacting with
the bot over the network can obtain the source. The default
`/star-comms status` reply and this repo's README already point at the
public source; if you fork and modify, update those references to your
fork before deploying.
