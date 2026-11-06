---
description: "Frozen LCRD gate-profile bundle: dsh-base plus the LCRD plugin row, for policy gates that must boot the candidate policy."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-lcrd-gate

English | [中文](README.zh.md)

## Summary

This private bundle inserts the LCRD plugin row (`id: lcrd`) over `dsh-base`. Create a profile named `lcrd-gate` from `dsh-base`, `dsh-headless`, and this bundle; generated gate overlays then target `id: lcrd` for the per-run log directory, policy root, budget, and candidate version. The bundle carries no plugin config of its own: a patch replaces the whole config row, so the deployment's generated overlay must restate the complete config. This is the profile the policy gate should boot instead of the bare `headless` profile, which does not mount the plugin.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Create the gate profile once, then point the plugin's `evolveGateProfile` at it:

```sh
dsh plugin --profile lcrd-gate add @deepseek-ai/dsh-base @deepseek-ai/dsh-headless @deepseek-ai/dsh-experimental-lcrd-gate
dsh --profile lcrd-gate "hello"
```

Set `evolveGateProfile: lcrd-gate` in the LCRD deployment config. The gate's probe then boots this profile, and each generated overlay overrides `id: lcrd` with the run's complete config.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the LCRD plugin row, which owns the protocol's model-facing behavior.

#### KV Cache effect

None; the bundle adds one plugin row and no model-visible content of its own.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- The package is private and is not published to npm.
- The profile must also compose `dsh-base` (the `skill` service) and `dsh-headless` (the one-shot runner); a profile that omits either fails at boot instead of producing a gate artifact.
- The bundle intentionally carries no plugin config. A later patch replaces the whole `id: lcrd` config, so every deployment-specific field must be restated by the generated overlay.
- No runtime invariant companion is published: the bundle only composes a patch and holds no mutable relation to audit.

<a id="dev-note"></a>
### Dev Note

None.
