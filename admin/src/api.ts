function cookie(name: string): string | null {
  const prefix = `${name}=`;
  for (const item of document.cookie.split(";")) {
    const value = item.trim();
    if (value.startsWith(prefix)) {
      return decodeURIComponent(value.slice(prefix.length));
    }
  }
  return null;
}

export async function adminApi<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (!(["GET", "HEAD", "OPTIONS"].includes(method))) {
    const csrf = cookie("hc_admin_csrf");
    if (!csrf && path !== "/auth/login") {
      throw new Error("Your secure session needs refreshing. Sign in again.");
    }
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }

  const response = await fetch(`/api/v1/admin${path}`, {
    ...options,
    method,
    headers,
    credentials: "include",
  });

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login") {
      window.dispatchEvent(new Event("hc-admin-session-expired"));
    }
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object" &&
      "message" in body.error &&
      typeof body.error.message === "string"
        ? body.error.message
        : `Request failed (${response.status}).`;
    throw new Error(message);
  }

  return body && typeof body === "object" && "data" in body
    ? body.data as T
    : body as T;
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}
