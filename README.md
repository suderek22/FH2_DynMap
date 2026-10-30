<img width="1917" height="916" alt="image" src="https://github.com/user-attachments/assets/bfd9b99a-1bf1-4b51-b6e7-6fa31deeceae" />
 
 # DynMap 0.1.2 (alpha)

Live 2D web map of Forza Horizon 2, served from the game on your own PC.
Open **http://localhost:8090/** in a browser while you drive.

This alpha only shows the host player. It is the base for multiplayer hosting later.

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
3. Press **Apply**. The result is saved in `DynMap.ini` (`Ax`, `Bx`, `Az`, `Bz`).

## Settings (`DynMap.ini`)
| Key | Default | |
|---|---|---|
| `Enabled` | 1 | Same as the Mods menu switch |
| `Port` | 8090 | 1024-65535 |
| `PlayerName` | Host | Name shown on the map |

The server listens on your network too (AllowLan=1, so a phone or other PC can open http://<PC IP>:8090/; Windows may ask to allow it through the firewall). Set AllowLan=0 for localhost only.

## Known limits
- Only the host player; the multiplayer session list is a placeholder.
- Heading comes from the movement direction, so it is only shown while moving.
- Landmarks: only the Horizon Festival so far.


