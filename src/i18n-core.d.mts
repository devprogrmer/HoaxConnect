export type SupportedLocale = "en" | "fa";
export type Direction = "ltr" | "rtl";

export declare const supportedLocales: readonly SupportedLocale[];
export declare function isSupportedLocale(value: unknown): value is SupportedLocale;
export declare function resolveInitialLocale(
  persistedLocale: string | null | undefined,
  hostLocale: string | null | undefined,
): SupportedLocale;
export declare function directionForLocale(locale: SupportedLocale): Direction;
export declare function interpolate(
  template: string,
  parameters?: Readonly<Record<string, string | number>>,
): string;
