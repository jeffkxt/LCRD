export async function retry(times, fn, options = {}) {
  let last
  for (let index = 0; index < times - 1; index += 1) {
    try {
      return await fn()
    } catch (error) {
      last = error
    }
  }
  throw last
}
