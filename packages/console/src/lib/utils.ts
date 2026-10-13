function toInitialCaps(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export function getTitle() {
  if (typeof document === "undefined") {
    return "Graffiticode";
  }

  let hostname = document.location.hostname;

  // Handle localhost as graffiticode (default)
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "Graffiticode";
  }

  // Strip common prefixes
  hostname = hostname.replace(/^(console|www)\./, '');

  // Strip TLD suffixes
  hostname = hostname.replace(/\.(com|org|net|io|dev|app|co)$/, '');

  return toInitialCaps(hostname || "graffiticode");
}

export function getPageTitle(suffix?: string): string {
  const title = getTitle();
  return suffix ? `Console - ${suffix}` : 'Console';
}
