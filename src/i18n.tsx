import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  directionForLocale,
  interpolate,
  resolveInitialLocale,
  type Direction,
  type SupportedLocale,
} from "./i18n-core.mjs";
import { en, type TranslationKey } from "./locales/en.ts";
import { fa } from "./locales/fa.ts";

const STORAGE_KEY = "hoaxconnect.locale";

type TranslationParameters = Readonly<Record<string, string | number>>;

interface I18nValue {
  locale: SupportedLocale;
  direction: Direction;
  t: (key: TranslationKey, parameters?: TranslationParameters) => string;
  setLocale: (locale: SupportedLocale) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

function readInitialLocale(): SupportedLocale {
  let persisted: string | null = null;
  try {
    persisted = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Locale detection still works when storage is unavailable.
  }
  return resolveInitialLocale(persisted, window.navigator.language);
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(readInitialLocale);
  const direction = directionForLocale(locale);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // A storage failure must not prevent language switching for this session.
    }
  }, [direction, locale]);

  const value = useMemo<I18nValue>(() => {
    const dictionary = locale === "fa" ? fa : en;
    return {
      locale,
      direction,
      setLocale: setLocaleState,
      t: (key, parameters) =>
        interpolate(dictionary[key] ?? en[key], parameters),
    };
  }, [direction, locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside LocaleProvider");
  return value;
}

export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className={`languageSwitcher ${className}`.trim()} aria-label={t("language.label")}>
      <button
        type="button"
        className={locale === "en" ? "languageActive" : ""}
        aria-pressed={locale === "en"}
        onClick={() => setLocale("en")}
      >
        EN
      </button>
      <button
        type="button"
        className={locale === "fa" ? "languageActive" : ""}
        aria-pressed={locale === "fa"}
        onClick={() => setLocale("fa")}
      >
        فارسی
      </button>
    </div>
  );
}
