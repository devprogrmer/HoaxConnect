export const supportedLocales = Object.freeze(["en", "fa"]);

export function isSupportedLocale(value) {
  return supportedLocales.includes(value);
}

export function resolveInitialLocale(persistedLocale, hostLocale) {
  if (isSupportedLocale(persistedLocale)) return persistedLocale;
  return String(hostLocale || "").toLowerCase().startsWith("fa")
    ? "fa"
    : "en";
}

export function directionForLocale(locale) {
  return locale === "fa" ? "rtl" : "ltr";
}

export function interpolate(template, parameters = {}) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (token, key) =>
    Object.hasOwn(parameters, key) ? String(parameters[key]) : token,
  );
}
