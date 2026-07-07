/** Hash-based routing utilities for the Campfire app. */

export function navigateTo(route: string): void {
  window.location.hash = route;
}
