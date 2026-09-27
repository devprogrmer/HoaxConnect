export function nativeAvailable() {
  return Boolean(
    window.hoax?.isDesktop &&
    window.hoax?.network
  );
}

function requireNative() {
  if (
    !window.hoax?.isDesktop ||
    !window.hoax.network
  ) {
    throw new Error(
      "Native network engine is only available inside the HoaxConnect desktop application."
    );
  }

  return window.hoax.network;
}

export async function nativePing(
  target: string,
  count = 8
) {
  return await requireNative().ping(
    target,
    count
  );
}

export async function nativeDiagnostic(
  target = "1.1.1.1"
) {
  return await requireNative().diagnostic(
    target
  );
}

export async function nativeTCPProbe(
  target: string,
  port: number
) {
  return await requireNative().tcpProbe(
    target,
    port
  );
}

export async function nativeTraceroute(
  target: string
) {
  return await requireNative().traceroute(
    target
  );
}
