# Corp Inventory Load — Design Spec

**Date:** 2026-08-17  
**Branch:** crz-aug2026-4

## Summary

Add a "Corp inventory (needs director access)" button to the Acquisitions Inventory tab that fetches corp hangar contents via ESI and lets the user add or replace their local acquisitions inventory with it.

## User Flow

1. User clicks "Corp inventory (needs director access)" button
2. App fetches `/api/corp/assets` from sidecar — shows spinner in status line
3. On success: inline breakdown appears showing each hangar division with item count
4. User clicks "Add to inventory" or "Replace inventory"
5. Items are merged/replaced into the local acquisitions inventory and saved

On error (missing scope): status shows "Re-auth a Director character on the Auth tab — needs `esi-assets.read_corporation_assets.v1` scope"

## Backend

### Scope

Add `esi-assets.read_corporation_assets.v1` to `DEFAULTS['scopes']` in `config.py`. Existing tokens won't have it — user must re-auth a director slot.

### Endpoint: `GET /api/corp/assets`

Uses `_scope_token('esi-assets.read_corporation_assets.v1')` to find a director-authed slot.

Fetches `GET /v5/corporations/{corp_id}/assets/` (paginated, all pages).

Filters to items at `home_structure_id`:
- `location_id == home_structure_id`
- `location_flag` in the corp hangar flag set

Groups items by `location_flag`, resolves type names from `type_meta.json` (falling back to type_id string).

Maps ESI flags to friendly names:

| ESI flag | Friendly name |
|---|---|
| `HangarAll` / `CorpSAG1` | Hangar Division 1 |
| `CorpSAG2` | Hangar Division 2 |
| `CorpSAG3` | Hangar Division 3 |
| `CorpSAG4` | Hangar Division 4 |
| `CorpSAG5` | Hangar Division 5 |
| `CorpSAG6` | Hangar Division 6 |
| `CorpSAG7` | Hangar Division 7 |

Note: EVE lets corps rename hangar divisions but ESI does not expose custom names. Friendly names above match EVE client defaults. Can revisit once names are decided in-game.

**Success response:**
```json
{
  "ok": true,
  "hangars": [
    {"flag": "HangarAll", "name": "Hangar Division 1", "item_count": 14203,
     "items": [{"type_id": 587, "name": "Rifter", "quantity": 5, "category_id": 6}]}
  ]
}
```

**Error response:**
```json
{"ok": false, "reason": "missing_scope"}
```

Reasons: `missing_scope`, `no_corp_id`, `no_credentials`, `fetch_failed`.

## Frontend

### Button placement

In `renderAcquisitionsTab`, add the button to the existing button row alongside Add / Replace / Copy / Clear.

### State

`acqCorpInventoryFetched` — cached fetch result (hangars array), cleared when the tab is rebuilt. Allows re-showing the breakdown on tab revisit without refetching.

### After fetch — inline breakdown

Below the button row, render a `<div id="acq-corp-breakdown">` with:
- One line per hangar: "Hangar Division 1 · 14,203 items"
- "Add to inventory" and "Replace inventory" buttons
- Dismiss/close button

### Add / Replace logic

Reuse the same merge logic as the paste flow:
- Items are split into hulls (category_id 6) and modules/other
- Add: sum quantities into existing `acquisitionsHulls` / `acquisitionsItems`
- Replace: overwrite both arrays
- Call `acquisitionsSave()` after either action

### Error display

Show error in the `#acq-status` span with a helpful re-auth message.
