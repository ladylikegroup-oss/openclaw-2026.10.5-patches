# Validation and deployment boundaries

## Verified for this publication

- Exported the complete changed-path union from the official base to the final source head: four families and 32 source/test/test-routing files.
- Reconstructed the changes in a separate bare Git scratch repository. No product module, test suite, installation script, or Gateway operation was executed for this check.
- Applied all four patches with `git apply --cached --check` followed by `git apply --cached`.
- Confirmed the intermediate trees after patches 0001 and 0003 match the recorded `a02d409` and `1e8c96e` commits.
- Confirmed the final tree matches `964c4c5` exactly.
- Independently applied the combined patch from the official base and obtained the same final tree.
- Preserved the final source files verbatim, with SHA-256 digests in `manifest.json`.
- Preserved the deployed Codex package verbatim. Its digest is recorded in `manifest.json` and the release checksums.

The machine-readable patch-application evidence is in `verification/patch-application.json`. This is real patch/content verification, not a substitute for a product build or functional test suite.

## Existing deployment evidence (2026-11-17)

- The Codex plugin package was applied through the native running-Gateway lifecycle. The operation returned success, no warnings, and `restartRequired:false`.
- A separate readback found the new plugin runtime active and all 177 packaged files identical to the approved archive.
- The core build, authored configuration file, and the adjacent service process identities remained unchanged during that operation.
- Two bounded operator-origin requests in the original conversation produced real channel messages. The second request omitted the first marker and the bot recalled it correctly. Both messages were independently read back.
- This established generation, outbound delivery, and continuation for those requests. It was not a newly exercised human-mention ingress test or an acceptance test of every business tool.

Only a privacy-safe summary is published. Internal conversations, message/account identifiers, local paths, raw logs, process receipts, and configuration are deliberately excluded.

## Source-only and unverified areas

- The startup Stop changes are source-only; they were not installed into the retained core.
- The read-only status source repair and its regression tests are included. The retained core had corresponding local guards; a newly built combined core package was not produced or deployed.
- The previous full-core build attempts did not complete. No failed or incomplete core binary is offered as an installable release asset.
- Existing focused regression evidence is historical. This publication did not rerun those tests or a full CI suite; no CI-green claim is made.
- Startup deadline reclassification is containment, not proof of the initiating stall's root cause. No live timeout fault was injected to exercise automatic failover during publication.
- Host SDK real-path equivalence was observed after the plugin update. That is resolution evidence, not a separate live fault-path constructor-identity test.

## Checksums

The release `SHA256SUMS` covers the downloadable package, source collection archive, and accompanying license. Verify the downloaded files before use. Do not compare only the package version string: the patched and unpatched Codex packages share the version `2026.10.5`.
