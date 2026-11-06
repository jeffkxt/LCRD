# Contract

- `parseBool(text)` ignores leading and trailing whitespace and is case insensitive.
- `"true"` and `"1"` are true; `"false"` and `"0"` are false.
- Every other input is rejected by throwing an `Error`; it never silently returns a boolean.

`check.mjs` samples this contract; it does not cover it completely.
- A non-string input is converted to text before being read.
- Inner whitespace is not stripped: `" t r u e "` is rejected.
