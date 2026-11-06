---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-20-lcrd-source-attribution

English | [中文](2026-10-20-lcrd-source-attribution.zh.md)

## Summary

Adds the `lcrd-hard-isolation` message source kind used by the optional LCRD hard-isolation plugin for its protocol notices, rollback feedback, and verifier prompts.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-20-lcrd-source-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "ce1c6a84f1aada8c98e3c99b0f4cefc62c88b8bf8129072206b042161e16671e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "10661f8b7df8f6abdc7ce0fa2de7aa8620f9b10543fcdfe46bc442b59a8c908f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "c71ece7d39baee99707b96612e78cd7ff38367810c7924349b354235af9f50fc"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "d279ef72221348d5941cd38afc39d05a2707af4c74bdd2b4fe5607947607fe02"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The kind is qualified as attribution-only: it is an optional, additive alternative on the existing user and developer message source unions. Readers that do not load the plugin already preserve unknown source kinds and their JSON metadata, and the kind imposes no validation, replay, or authority requirement. The producer's own flow recorder reads the kind to label recorded events; every other reader derives the same messages without that projection.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/lcrd: 373 tests passed, including the real-composition Loader boot tests. pnpm run verify-persistence-catalog and pnpm run verify-persistence-changes pass with this record.

<a id="dev-note"></a>
## Dev Note

None.
