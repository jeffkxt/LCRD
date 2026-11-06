import { slugify } from './source/slug.js'

const cases = [
  ["collapses repeated spaces", async () => slugify('Hello  World') === 'hello-world'],
  ["trims the edges", async () => slugify(' a b ') === 'a-b'],
  ["collapses punctuation runs", async () => slugify('A--B') === 'a-b'],
  ["drops a trailing symbol", async () => slugify('Hello!') === 'hello'],
  ["keeps unicode letters", async () => slugify('Café Ünïcode') === 'café-ünïcode'],
  ["caps the length", async () => (() => { const slug = slugify('x'.repeat(100) + '---' + 'y'.repeat(100)); return slug.length <= 80 && !slug.endsWith('-') })()],
  ["no alphanumerics", async () => slugify('---') === ''],
  ["truncation keeps content", async () => (() => { const slug = slugify('é'.repeat(200)); return slug.length <= 80 && slug.length > 0 })()],
]

let passed = 0
for (const [label, check] of cases) {
  let ok = false
  try {
    ok = (await check()) === true
  } catch {
    ok = false
  }
  if (ok) passed += 1
  else console.error('FAIL ' + label)
}
console.log(passed / cases.length)
