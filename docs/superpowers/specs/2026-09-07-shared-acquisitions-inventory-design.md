# Shared Acquisitions Inventory via Quota Repo

**Date:** 2026-09-07  
**Status:** Approved

## Problem

The acquisitions inventory (hulls and modules scanned from the corp hangar) is stored locally on the machine that ran the scan. Other alliance members running the app see an empty inventory and cannot run hull-completion analysis against shared stock.

## Goal

Make the acquisitions inventory visible to all alliance members who have the quota repo configured, with admin-gated writes.

## Design

### Storage

A new file `acquisitions-inventory.json` stored in the alliance quota GitHub repo alongside `quotas.json`. Shape mirrors the existing local file:

```json
{
  "hulls": [{"type_id": 123, "name": "Tornado", "quantity": 4}, ...],
  "items": [{"type_id": 456, "name": "Damage Control II", "quantity": 12}, ...],
  "updated_at": "2026-09-07T10:00:00+00:00"
}
```

### Config

No new config fields. Reuses existing quota repo fields:

| Field | Role |
|---|---|
| `alliance_quota_url` | Locates the repo (owner/repo/branch extracted from this URL) |
| `alliance_quota_pat_read` | Used to pull `acquisitions-inventory.json` |
| `alliance_quota_pat_write` | Used to push `acquisitions-inventory.json` |
| `alliance_quota_allow_push` | Gates the Push Inventory button (same checkbox as quota push) |

### Backend — `python/server.py`

Two new endpoints, mirroring the existing quota sync/push pattern:

**`POST /api/acquisitions/sync`**
- Reads `acquisitions-inventory.json` from the quota repo using `_github_contents_get` with the read PAT.
- On success: writes to local `acquisitions_inventory.json` and returns `{hulls, items, updated_at}`.
- On failure (no URL, no file, PAT error, network): returns `{"error": "..."}` — caller falls back to local file.
- Uses `_parse_github_blob_url` on `alliance_quota_url` to derive `owner/repo/branch`; the inventory file path is always `acquisitions-inventory.json` at the repo root.

**`POST /api/acquisitions/push`**
- Returns 403 if `alliance_quota_allow_push` is not set in config.
- Reads current local inventory, serialises to JSON, pushes to `acquisitions-inventory.json` in the repo via `_github_contents_put` (get SHA first, pass `None` if file doesn't exist yet).
- Commit message: `"Update acquisitions inventory — {N} hull(s), {M} item(s)"`.
- Returns `{pushed_hulls, pushed_items, commit_sha, commit_html_url}`.

### Frontend — `renderer/app.js`

**`acquisitionsLoad()` (startup)**  
Extend to attempt remote sync before falling back to local:
1. Call `POST /api/acquisitions/sync` silently.
2. If it returns valid data, use it and update `acquisitionsUpdatedAt`.
3. If it errors or the quota URL is not configured, fall through to the existing `GET /api/acquisitions` local load.

This means all users auto-pull the latest inventory on startup with no extra config or user action.

**Push Inventory button**  
- Added to the Acquisitions tab controls row, next to the existing buttons.
- Visible only when `alliance_quota_allow_push` is true (read from config on tab render, same as how stockpile gates its admin panel).
- On click: calls `POST /api/acquisitions/push`, shows status in `#acq-status` span (`"pushing…"` → `"pushed — commit abc1234"` or an error message).

### Error handling

- Sync failure on startup is silent (no toast, no blocking UI) — the local file is the fallback.
- Push failure is shown in `#acq-status` with the error text from the response.
- If the quota URL is not configured at all, sync is skipped entirely (no error shown).

## Files Changed

| File | Change |
|---|---|
| `python/server.py` | Add `POST /api/acquisitions/sync` and `POST /api/acquisitions/push` endpoints |
| `renderer/app.js` | Extend `acquisitionsLoad()` to attempt remote sync; add Push Inventory button and its click handler |

## Out of Scope

- Auto-push after scan (user explicitly pushes)
- Conflict resolution (last-write-wins via GitHub SHA)
- Per-user access control beyond the existing allow-push checkbox
