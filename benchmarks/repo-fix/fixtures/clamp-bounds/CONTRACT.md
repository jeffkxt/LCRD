# Contract

- `clamp(value, min, max)` returns `value` when it already lies inside the inclusive range.
- A value below the range returns the lower bound; a value above it returns the upper bound.
- A reversed range (`min > max`) is handled the same way, using the smaller bound as the lower end.
- A `NaN` value never escapes: the call returns the lower bound instead.

`check.mjs` samples this contract; it does not cover it completely.
- An equal-bounds range (`min === max`) returns that single bound.
- Infinities are clamped like any other out-of-range value.
