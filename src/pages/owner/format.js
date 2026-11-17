// Display formats from the design spec (Interaction and accessibility rules): local time
// "Sep 26, 2:14 PM", durations "2 min 14 sec", and "Version [n]" labels, never an internal id.

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

export function formatDateTime(value) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? DATE.format(time) : '';
}
export function formatDay(value) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? DAY.format(time) : '';
}
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (!minutes) return `${rest} sec`;
  return `${minutes} min ${rest} sec`;
}
/** Time left until `value`, in plain words: "Expires in 23 hr", "Expires in 40 min". Rounds up so a new 24 hour link reads "24 hr". */
export function expiresIn(value, now = Date.now()) {
  const time = Date.parse(value ?? '');
  if (!Number.isFinite(time)) return '';
  const minutes = Math.ceil((time - now) / 60_000);
  if (minutes <= 0) return 'Expired';
  if (minutes < 60) return `Expires in ${minutes} min`;
  return `Expires in ${Math.ceil(minutes / 60)} hr`;
}
export const versionLabel = (number) => (number ? `Version ${number}` : 'Version');
export const countLabel = (count, one, none = 'No information added') => (count === 0 ? none : `${count} ${count === 1 ? one : `${one}s`}`);
export const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.max(0, Math.floor(seconds % 60))).padStart(2, '0')}`;
