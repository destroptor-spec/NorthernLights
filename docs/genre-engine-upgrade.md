# Genre engine upgrade: deploy runbook

Every step needed to take branch `genre-engine-next` to prod, in one place. Each phase of [the genre & style redesign](./Aurora%20genre%20and%20style%20redesign.md) adds its steps here when it is built, so after the complete branch this page is the whole checklist. Steps run in the order listed.

| Phase | What it changes on prod | Status |
| --- | --- | --- |
| 0 | Python 3.14 venv, new analysis models, `track_style_scores`, full re-analysis | Built (`038e736`), not deployed |
| 1 | Genre list, MusicBrainz genre snapshot, tag mapping, artist-tag split, Last.fm backfill | Not built |
| 2 | New Browse behind a setting | Not built |
| 3 | Audio, KNN and Last.fm evidence; style centroids | Not built |
| 4 | Engine scoring; Genre Matrix and MBDB import retired | Not built |

Prod facts these steps rely on: host `10.10.0.12`, app in `~/NorthernLights`, deployed with `scripts/deploy-prod.sh` (leaves the checkout detached, keeps `dist-prev` for `--rollback`, and exports the database first whenever a deploy changes the schema).

## Before deploying

- [ ] The branch is merged to `main` (or the commit to deploy is on `origin`).
- [ ] A quiet window is planned: phase 0 re-analyses the whole library (see Phase 0, step 4).
- [ ] Optional: a VM-level backup. The deploy script's automatic database export covers the schema change.

## Phase 0: three-window analysis (feature version 3)

### 1. Rebuild the Python environment (can be done before the deploy)

`deploy-prod.sh` does not manage `.venv`. The current Essentia build needs Python 3.14. The old analysis code also runs on it (outputs verified identical), so this step is safe ahead of the deploy. Do not run it while an analysis is in progress, since analysis workers use `.venv`.

```bash
ssh andreas@10.10.0.12 'cd ~/NorthernLights && export PATH="$HOME/.local/bin:$PATH" \
  && uv venv --clear --python 3.14 .venv \
  && uv pip install --python .venv/bin/python "essentia-tensorflow==2.1b6.dev1438" \
  && .venv/bin/python -c "import sys, importlib.metadata as m; print(sys.version.split()[0], m.version(\"essentia-tensorflow\"))"'
```

Expected output: `3.14.x 2.1b6.dev1438`.

### 2. Deploy

```bash
ssh andreas@10.10.0.12 'bash -s -- main' < scripts/deploy-prod.sh
```

The deploy adds the `track_style_scores` table at startup (`CREATE TABLE IF NOT EXISTS`), so the script exports the database first (label `pre-<commit>`).

### 3. Check the models

At startup the server downloads four new model files (about 3.6 MB in total) from `essentia.upf.edu` into `server/models`: the style model and three classifiers. Analysis does not start until all of them are present.

- [ ] Settings → Database → models: every model is cached. If a download failed (prod has had outbound fetch blips), use Redownload there.

### 4. Re-analyse the library

Every track is now outdated (version 2 < 3). Analysis starts on the first scan that finds a new or changed file, or by hand:

- [ ] Optional: Settings → System → audio analysis CPU → Maximum for the run.
- [ ] Settings → Library → Analyze Pending.

On dev, 30,700 tracks take about 1.5 h at 6 workers; prod depends on its CPU. While it runs, Infinity only pairs tracks analysed with the same version as the seed, so recommendations draw on a smaller pool until the run finishes.

### 5. Verify

```bash
ssh andreas@10.10.0.12 'cd ~/NorthernLights && eval "$(grep -E "^(DB_USER|DB_NAME|DB_CONTAINER_NAME)=" .env)" \
  && podman exec -i "${DB_CONTAINER_NAME:-music-postgres}" psql -U "$DB_USER" -d "$DB_NAME"' <<'SQL'
SELECT feature_version, is_simulated, count(*) FROM track_features GROUP BY 1, 2 ORDER BY 1, 2;
SELECT count(*) AS style_rows, min(analyzed_at), max(analyzed_at) FROM track_style_scores;
SQL
```

- [ ] All non-simulated rows are at `feature_version` 3.
- [ ] `style_rows` equals the number of non-simulated version-3 rows.
- [ ] Settings → Library shows no outdated analysis.

### 6. Optional cleanup

- [ ] Delete `server/models/msd-musicnn-1.pb` on prod: MusiCNN is no longer used.

### Rollback

`ssh andreas@10.10.0.12 'bash -s -- --rollback' < scripts/deploy-prod.sh` restores the previous build. No database restore is needed: the old code treats version-3 rows as analysed, its Infinity keeps versions apart, it ignores `track_style_scores`, and it runs on the Python 3.14 venv. Rolling forward again resumes the re-analysis where it stopped.

## Phase 1: genre list and tag mapping

Steps are added here when phase 1 is built. Known so far: the Discogs genre list and MusicBrainz genre snapshot are seeded at startup (schema change, so another automatic export); Last.fm and MusicBrainz artist tags are split per provider; and a slow, rate-limited Last.fm backfill runs in the background (about 4,800 artists on prod).

## Phase 2: new Browse

Steps are added here when phase 2 is built.

## Phase 3: audio and artist-tag evidence

Steps are added here when phase 3 is built.

## Phase 4: engine switch and retirements

Steps are added here when phase 4 is built. Known so far: the MBDB import (4 GB download) and the Genre Matrix are retired, and `tracks.genre_id` / `track_genres` are rebuilt from the new genres.
