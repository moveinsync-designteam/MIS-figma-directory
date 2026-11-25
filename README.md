# Figma Directory

A searchable index of MoveInSync's Figma files. Search by screen name, click through to
the exact frame. No Figma account needed to search — only to open a file.

**Live site:** https://moveinsync-designteam.github.io/MIS-figma-directory/

| | |
|---|---|
| `/WIS/` | WorkInSync — desk booking, visitor management, meeting rooms, cafeteria, admin |
| `/ets/` | ETS — shuttle, routing, billing, driver experience, safety, MIS 2.0 |

## How it stays up to date

A GitHub Action (`.github/workflows/refresh-index.yml`) runs every night at 02:00 IST.
It asks Figma which files changed, re-reads only those, and commits a fresh index.
Nobody's laptop is involved.

ETS is indexed from **folders**: every file inside the twelve Figma folders listed in
`ets/figma-directory-config.json` is picked up automatically, so a designer adding a file
needs to do nothing. WorkInSync is still indexed from an explicit file list and can be
switched to folders the same way.

## Adding Figma files

- **ETS** — nothing to do if the file lives in one of the twelve folders. To add a whole
  new folder, paste its URL into the `folders` list in `ets/figma-directory-config.json`.
- **WorkInSync** — add an entry to the `files` list in `WIS/figma-directory-config.json`.
  Only `link` is required.

Committing either config triggers a refresh of that directory within a minute or two.

## Running it by hand

Actions tab → **Refresh Figma index** → **Run workflow**:

- **Count files only** — counts what is in each Figma folder and stops. Writes nothing.
- **Which directory** — `ets`, `workinsync`, or `both`.
- **Only this module** — e.g. `Shuttle`, to refresh one module at a time.
- **Re-index every file** — ignore the "has it changed?" check.

## Setup

Needs one repository secret, `FIGMA_TOKEN`: a Figma personal access token with
**File content: read-only** *and* **Folders: read-only**. Folder discovery fails without
the second one. Also set Settings → Actions → General → Workflow permissions to
**Read and write**, so the job can commit its results.

## Relationship to the old repo

This is the successor to `figmadirectory/Figmadirectory`, which holds the original
WorkInSync-only directory. That repo is untouched and still live; nothing here affects it. `WIS/figma-directory-data.json` here
started as a copy of its index, so WorkInSync works in this repo from day one without
re-indexing.

## Previews

Hovering a result shows one key screen in a floating panel, loaded straight from
Figma with `embed.figma.com`. The embed respects each viewer's own Figma
permissions, so no design is exposed to anyone who could not already open it, and
no images are stored or published here. The Preview button turns it off, and that
choice is remembered per browser.

## What is published, and what is not

The index ships as `figma-directory-data.bin`, a gzipped blob rather than readable
JSON. With `robots.txt` and `noindex` tags that keeps the directory out of search
results and out of casual view in this public repo. It is obfuscation, not access
control: anyone who deliberately looks can still decompress it.

Every run audits Figma share settings and flags any file set to "anyone with the
link" in the run summary. Those are the only files a published file key actually
exposes, since Figma enforces permissions on everything else.

## Safety behaviour

- A file that fails to index keeps its previous data; everything else still publishes.
- If folder discovery fails, nothing is removed from the directory and the run summary says why.
- If there is nothing at all to index, the job refuses to write rather than publishing an empty site.
- Progress is saved after every file, so a run that times out resumes where it stopped.
