/**
 * The shared history stores a compact snapshot of an ability application.
 * The short text is derived from the full description so the ability model
 * does not need a second, manually maintained field.
 */
export function abilityEventSummary(description: string, limit = 160): string {
  const normalized = description.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return 'Без описания';
  const firstLine = normalized.split('\n').map((line) => line.trim()).find(Boolean) ?? normalized;
  if (firstLine.length <= limit) return firstLine;
  return `${firstLine.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}
