type CatalogEntry = {
  name: string;
  steamId?: number;
  executables: readonly string[];
};

export const gameCatalog: readonly CatalogEntry[] = [
  { name: "Counter-Strike 2", steamId: 730, executables: ["cs2.exe"] },
  { name: "Dota 2", steamId: 570, executables: ["dota2.exe"] },
  { name: "Apex Legends", steamId: 1172470, executables: ["r5apex.exe", "r5apex_dx12.exe"] },
  { name: "PUBG: BATTLEGROUNDS", steamId: 578080, executables: ["tslgame.exe"] },
  { name: "Overwatch", steamId: 2357570, executables: ["overwatch.exe"] },
  { name: "Rainbow Six Siege", steamId: 359550, executables: ["rainbowsix.exe", "rainbowsix_dx11.exe", "rainbowsix_vulkan.exe"] },
  { name: "Warframe", steamId: 230410, executables: ["warframe.x64.exe"] },
  { name: "Team Fortress 2", steamId: 440, executables: ["tf_win64.exe"] },
  { name: "Destiny 2", steamId: 1085660, executables: ["destiny2.exe"] },
  { name: "Call of Duty", steamId: 1938090, executables: ["cod.exe"] },
  { name: "ELDEN RING", steamId: 1245620, executables: ["eldenring.exe"] },
  { name: "Battlefield 2042", steamId: 1517290, executables: ["bf2042.exe"] },
  { name: "Fortnite", executables: ["fortniteclient-win64-shipping.exe"] },
  { name: "VALORANT", executables: ["valorant-win64-shipping.exe"] },
  { name: "League of Legends", executables: ["league of legends.exe"] },
  { name: "Roblox", executables: ["robloxplayerbeta.exe"] },
  { name: "Rocket League", executables: ["rocketleague.exe"] },
  { name: "FiveM", executables: ["fivem.exe"] },
  { name: "Genshin Impact", executables: ["genshinimpact.exe"] },
  { name: "World of Warcraft", executables: ["wow.exe", "wowclassic.exe"] },
];

export const appCatalog: readonly CatalogEntry[] = [
  { name: "Discord", executables: ["discord.exe"] },
  { name: "Firefox", executables: ["firefox.exe"] },
  { name: "Google Chrome", executables: ["chrome.exe"] },
  { name: "Microsoft Edge", executables: ["msedge.exe"] },
  { name: "OBS Studio", executables: ["obs64.exe"] },
  { name: "Spotify", executables: ["spotify.exe"] },
  { name: "Steam", executables: ["steam.exe"] },
  { name: "Telegram Desktop", executables: ["telegram.exe"] },
  { name: "Epic Games Launcher", executables: ["epicgameslauncher.exe"] },
  { name: "Battle.net", executables: ["battle.net.exe"] },
  { name: "VLC media player", executables: ["vlc.exe"] },
];

export function gameArtwork(steamId: number) {
  return `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${steamId}/header.jpg`;
}
