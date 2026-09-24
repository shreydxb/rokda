// Axis maths shared by every chart, kept free of React so it can be tested
// on its own.

// A "nice" tick step: 1, 2, 2.5 or 5 times a power of ten, chosen so roughly
// `count` intervals cover the span. Axis labels a reader can add up in their
// head (0 / 250K / 500K) rather than whatever the data's extremes divide into.
function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  const factor = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  return factor * magnitude;
}

// Ticks spanning [min, max], always including zero: a bar or column that does
// not start at zero misstates its own length, and a line chart of money is
// read against zero (a net worth below it means more owed than owned).
export function niceTicks(min, max, count = 4) {
  let lo = Math.min(0, Number.isFinite(min) ? min : 0);
  let hi = Math.max(0, Number.isFinite(max) ? max : 0);
  if (lo === hi) hi = lo + 1;
  const step = niceStep(hi - lo, count);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks = [];
  // Integer multiples of the step, trimmed of float noise, so a tick never
  // renders as 0.6000000000000001.
  for (let k = Math.round(lo / step); k <= Math.round(hi / step); k++) ticks.push(Number((k * step).toPrecision(12)));
  return { min: lo, max: hi, ticks };
}

// Linear map from a value to a pixel offset from the top of a plot `height`
// tall, for a domain [min, max].
export function yScale(min, max, height) {
  const span = max - min || 1;
  return (v) => height - ((v - min) / span) * height;
}

// Which of `count` evenly spaced x positions sit under a pointer at `offsetX`
// across a plot `width` wide — nearest, not "inside", so the pointer never
// has to land exactly on a thin mark.
export function nearestIndex(offsetX, width, count) {
  if (count <= 0 || width <= 0) return null;
  const band = width / count;
  return Math.max(0, Math.min(count - 1, Math.floor(offsetX / band)));
}

// Stacks one column's segments: positives upward from zero in the order
// given, negatives downward. Returns [from, to] per segment, in value units.
// A negative starting net worth or a year of dissaving is a real state, and
// stacking it upward would draw debt as if it were savings.
export function stackSegments(values) {
  let up = 0;
  let down = 0;
  return values.map((v) => {
    const n = Number(v) || 0;
    if (n >= 0) {
      const from = up;
      up += n;
      return [from, up];
    }
    const from = down;
    down += n;
    return [down, from];
  });
}
