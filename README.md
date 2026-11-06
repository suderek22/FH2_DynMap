<img width="1908" height="924" alt="image" src="https://github.com/user-attachments/assets/fc80f6fc-b7b4-44d7-a6a2-ef76b566eba3" />

 
# DynMap 0.3.0 (alpha)

Live 2D web map of Forza Horizon 2, served from the game on your own PC.
Open **http://localhost:8090/** in a browser while you drive.

This alpha shows the local player and optional demo Drivatars. It is the base for multiplayer hosting later.

## 0.3.0 map and UI updates
- Settings > Map switches between Anthem and Storm Island, remembering the choice in this browser.
- The Island textures and all overlays/headings rotate 90 degrees left for readable map labels.
- Players and AI appear only on their current settled map, using the native active-track manager
  (542 = Anthem, 549 = The Island). During travel they are hidden; viewing the other map shows a hint.
- Both maps support roads, cameras, road-following speed zones, tracking, trails, wristband colours,
  brightness and speed units. Storm Island has five cameras and five speed zones; no barn-find marker.
- Each sidebar can be hidden with its arrow and restored using the screen-edge tab.
- "Show player names always" gives unfocused players smaller wristband-coloured badges at 80% opacity.
  Selected players retain the triangle/full-size badge; others use grey dots.
- Clicking empty map clears selection and trails. Only the selected player records a 120-second trail.
- Calibration is independent: `[DynMap]` for Anthem, `[DynMap.Island]` for Storm Island.
  Reset affects the selected map only; switching clears trails and pending calibration points.

## Build and generate local Island assets
Game textures, binaries, runtime settings and extracted Island navigation data are not included in this PR.
Generate the assets locally from your game files. From the repository root in PowerShell:

```powershell
cmake -S . -B build -DFH2MOD_INCLUDE_DIR="C:\path\to\FH2-Mod-Platform\include"
cmake --build build --config Release

# Requires numpy, Pillow, scipy, texture2ddecoder and a local xg.dll.
$env:DYNMAP_XG_DLL = "C:\path\to\xg.dll"
python tools\build_island_map.py --archive "C:\game\media\ui\textures\data_bound\The_Island.zip" --profile "C:\game\media\ui\MapProfileIsland.xml" --output maps\island
python tools\extract_overlays.py --gameobjs "C:\dlc\media\tracks\test03\ribbon_00\GameObjs.xml" --output maps\island\data\overlays.json
python tools\export_roads.py --nav "C:\dlc\media\tracks\test03\ribbon_00\Test03_00.nav" --output-dir maps\island\data
python tools\mock_server.py
```

The mock is at http://127.0.0.1:8091 and plays on Anthem by default.
Set `DYNMAP_MOCK_MAP=island` before starting it to test the other map.
Existing mainland tiles, icons and Leaflet vendor files must be supplied locally as before.
For installation, place the DLL in `fh2-mods` and the root website files, `data`, generated `maps`,
`tiles`, `icons` and `vendor` under `fh2-mods\DynMap\web`. Preserve your existing `DynMap.ini`.

## Features
- The whole FH2 map, built from the game's own `Anthem_Map` textures (7168 x 4096, zoomable).
- Forza Horizon themed page: sessions and settings on the left, players on the right.
- Click a player to zoom to them; the map keeps following while they move. Dragging the map stops following.
- Trail, speed (km/h or mph), brightness, landmarks (Horizon Festival pin from the game's map icons).
- Position calibration tool in the page (see below).
- Update check against https://github.com/suderek22/FH2_DynMap.
- On/off switch in the Mods menu ("Live web map").

## Install
Needs FH2 Mod Platform 2.8.0+. Copy the content of `fh2-mods` into the game's `fh2-mods` folder
(`DynMap.dll` and the `DynMap` folder with the `web` files).

## Calibration (first use)
The mod reads the car's world position in metres; the page has to map it to the picture.
The default is only a guess, so calibrate once:
1. Drive to a place you can find on the map, press **Add point**, click that place on the map.
2. Drive to a second place far away (different in both directions), do it again.
3. Press **Apply**. The result is saved in `DynMap.ini` (`Ax`, `Bx`, `Az`, `Bz`) in the selected map's section.

## Settings (`DynMap.ini`)
| Key | Default | |
|---|---|---|
| `Enabled` | 1 | Same as the Mods menu switch |
| `Port` | 8090 | 1024-65535 |
| `PlayerName` | Windows user name | Name shown on the map; override with your nick |
| `ShowAI` | 1 | Demo Drivatars; set 0 and restart to disable |
| `Wristband` | 0 | Tier 1-7; unknown/0 uses white |

The server listens on your network too (AllowLan=1, so a phone or other PC can open http://<PC IP>:8090/; Windows may ask to allow it through the firewall). Set AllowLan=0 for localhost only.

## Known limits
- The multiplayer session list is a placeholder. AI names are assigned from the game's gamertag cache,
  not matched to their real drivers; AI wristbands are simulated.
- Heading comes from the movement direction, so it is only shown while moving.
- Landmarks: mainland Horizon Festival only.
- Island roads use NAV tags, with unclassified routes rendered in the standard-road style.
- The local wristband is configured through `Wristband`, not automatically read from the save.
