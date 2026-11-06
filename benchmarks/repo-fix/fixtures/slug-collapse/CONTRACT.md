# Contract

- `slugify(text)` lowercases the input.
- Every run of characters that are neither a letter nor a digit collapses into a single `-`; Unicode letters such as `é` and `ü` count as letters.
- Leading and trailing `-` are removed.
- The result never exceeds 80 characters, and truncation never leaves a trailing `-`.

`check.mjs` samples this contract; it does not cover it completely.
- An input with no letters or digits yields the empty string.
- Truncation never produces an empty slug; only trailing dashes are stripped.
