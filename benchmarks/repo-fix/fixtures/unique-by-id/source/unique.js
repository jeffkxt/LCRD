export function unique(items) {
  return items.filter((item, index) => items.indexOf(item) === index)
}
