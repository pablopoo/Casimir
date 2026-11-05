export function discoveryDisplayName(document: { displayName?: unknown }): string {
  const name = typeof document.displayName === 'string' ? document.displayName.trim() : '';
  return name || 'Void Cloud';
}

export function platformPageTitle(page: string, platformName: string): string {
  return `${page} · ${platformName}${/\bvoid\b/i.test(platformName) ? '' : ' · Void'}`;
}
