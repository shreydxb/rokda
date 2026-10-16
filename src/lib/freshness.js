// "Loaded 14:32", or with the date when the read was not today.
export function loadedLabel(loadedAt, now = new Date()) {
  if (!loadedAt) return null;
  const time = loadedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (loadedAt.toDateString() === now.toDateString()) return `Loaded ${time}`;
  return `Loaded ${loadedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`;
}

