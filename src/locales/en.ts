export const en = {
  "language.english": "English",
  "language.persian": "Persian",
  "language.label": "Language",
  "auth.signIn": "Sign in",
  "auth.createAccount": "Create account",
  "nav.home": "Home",
  "nav.gamesApps": "Games & Apps",
  "nav.networkDoctor": "Network Doctor",
  "nav.settings": "Settings",
  "status.installed": "Installed",
  "status.running": "Running",
  "status.selected": "Selected",
  "status.notInstalled": "Not installed",
  "common.search": "Search",
  "common.retry": "Retry",
  "common.cancel": "Cancel",
} as const;

export type TranslationKey = keyof typeof en;
