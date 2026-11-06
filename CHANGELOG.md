# DynMap 0.3.0
- Read native active/target track and travel state; publish players and AI only on their current, settled map.
- Show the session's actual map when viewing the other map; removed the Island barn-find marker.
- Added Anthem / Storm Island map selector, remembered per browser.
- Storm Island textures are rotated 90 degrees left, together with all markers, roads, zones and headings.
- Added DLC road tags, five speed cameras and five road-following speed zones.
- All existing player tracking, trail, name badge, layer, brightness and panel controls work on both maps.
- Independent Island calibration in [DynMap.Island]; switching clears trails and pending calibration points.
- Map loading and calibration errors are displayed; outdated responses after switching are ignored.
- Drivatars (AI racers) are listed with a name, car, speed and wristband colour, and shown on the map. Names and wristbands are simulated for now; `ShowAI=0` in DynMap.ini turns them off.
- Drivatar hook fixed (the first attempt was rejected by the game's code layout, so none showed). Names are now real gamertags read from media\DrivatarGlobalCache\DefaultCache.bin (25 unique); pairing with cars and wristbands is still simulated.
- Clicking empty map unfocuses the player; click a marker or list row to focus. Auto-focus happens only once at start.
- Players list and settings panels can be hidden with an arrow; edge tabs bring them back.
- New setting "Show player names always": small 80%-opacity name badges in the wristband colour for unfocused players.
- Only the selected player has the triangle marker and a trail; everyone else is a grey dot.
- Your own name shows without the (host) suffix; default is your Windows user name (set PlayerName in DynMap.ini).

# DynMap 0.1.9
- Road classes re-derived from a full sweep of the in-game map (97 extra screenshots), so freeway / dirt / standard roads are more accurate.
- (A separate shortcut / AI-route class was tried and dropped: the game data has no reliable flag for which roads the map draws.)

# DynMap 0.1.8
- Road classes (freeway, B, dirt) now come from the game's pause-menu map screenshots, aligned to our map. Roads use the game's colours: freeway light yellow, dirt salmon, others white.

# DynMap 0.1.7
- Roads layer rebuilt from the game's road records: roads are joined at junctions, and are styled by class (freeway pink, A gold, B cream, dirt dashed brown).
- Speed zones now follow the road between start and end instead of a straight line.
- Player name tag is black when the player colour is white (or yellow).

# DynMap 0.1.6
- New layers (left panel): Roads (off by default), Speed cameras, Speed zones (Aâ†’B).
- Player colour is now the Forza Horizon wristband tier (1 yellow, 2 green, 3 blue, 4 pink, 5 orange, 6 purple, 7 gold); unknown = white.
- The tier is not read from the game yet. Set `Wristband=1..7` in DynMap.ini as a manual fallback (0 = white).

# DynMap 0.1.5
- Fixed clipped map icons (player arrow, car pin, Horizon Festival pin) by re-cropping them from the game's icon sheet.
- Top-left logo: white stamp with the H cut out, readable on the pink bar.
- Trails are cleared after 120 s and are kept per player.
- Each player gets a colour (class colour when the class is known, otherwise a palette colour) used for the trail, the map marker and a bar in the players list.

Still open: street layer; speed camera / speed zone layer; sending the car class from the game.
