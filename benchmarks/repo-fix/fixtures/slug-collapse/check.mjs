import { slugify } from './source/slug.js'

const cases = [
  ["single space already works", async () => slugify('Hello World') === 'hello-world'],
  ["collapses repeated spaces", async () => slugify('Hello  World') === 'hello-world'],
  ["trims the edges", async () => slugify(' a b ') === 'a-b'],
  ["collapses punctuation runs", async () => slugify('A--B') === 'a-b'],
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
