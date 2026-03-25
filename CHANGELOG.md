# Changelog

All notable changes to this project will be documented in this file.

## v0.1.40 - 2026-03-25

Recovery release for the March 24, 2026 merge batch.

### Recovery note

The automated release workflow partially created tag `v0.1.39` during a failed push to `main`.
That tag did not correspond to a stable released `main` state, so the skipped merge batch is
documented here instead of being backfilled as synthetic releases.

### Included changes

- [#104](https://github.com/redxzeta/blackice/pull/104) documented the full log explainer endpoint surface in the README, including status and metadata examples.
- [#113](https://github.com/redxzeta/blackice/pull/113) normalized `LOG_LEVEL` parsing by trimming and lowercasing supported values before validation.
- [#116](https://github.com/redxzeta/blackice/pull/116) added schema validation for `/analyze/logs/metadata` responses.
- [#118](https://github.com/redxzeta/blackice/pull/118) added secret redaction for log analysis prompts and responses.
- [#120](https://github.com/redxzeta/blackice/pull/120) centralized remaining runtime config into YAML-backed runtime configuration.
- [#133](https://github.com/redxzeta/blackice/pull/133) added structured discovery metadata for `/analyze/logs/targets` in Loki mode.
- [#134](https://github.com/redxzeta/blackice/pull/134) refreshed raw batch `no_logs` handling and empty-result messaging.
