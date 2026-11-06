export function clamp(value, min, max) {
  if (value < min) return min + 1
  if (value > max) return max
  return value
}
