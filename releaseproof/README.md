# ReleaseProof review report v1

This standalone module produces deterministic JSON and an offline HTML review of an exact evidence packet. It uses Node.js built-ins and adds no package dependency. It does not change the ChangeGate application, seven WebMCP tools, approval/execute controls or historical offline verifier.

## Use

```bash
node releaseproof/cli.mjs --expected trusted-expectation.json --packet evidence-packet.json --out review-output
```

The expectation file comes from the human collector, separately from model text and evidence. It fixes the project, commit, pipeline, all five job IDs and explicit UTC review time. Optional `owner_disposition` records a bounded human risk decision for that exact source; this report does not authenticate the record. The packet carries native metadata, raw UTF-8 summary/exits strings and their byte-count/digest/provenance descriptors. See `fixtures.mjs` for a synthetic contract example.

Outputs are `review.json` and `review.html`. Exit 0 means report generation succeeded; it does **not** mean the pipeline passed or release was approved. Invalid evidence returns exit 2 before creating outputs.

The input contract is `releaseproof-packet/v1`; trusted expectation is `releaseproof-expectation/v1`; output is `releaseproof-review/v1`. Use explicit `reviewed_at`, not an implicit clock, so identical inputs produce identical bytes.

## Evidence boundary

- Successful application and scanner/audit execution is required. Findings are separate from command execution. A full audit exit 1 with findings can be a valid completed audit.
- A failed assessment and failed pipeline remain failed when complete evidence explains the findings. Zero findings require successful native assessment/pipeline records.
- Raw-file SHA-256 and byte counts are checked. These establish integrity within the supplied packet, not provider authenticity. `native-artifact` is a collector-supplied provenance label; it is reported as `NATIVE_BYTES_DECLARED` and never as a signed attestation.
- Trace-derived and synthetic inputs remain `INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE`. Do not relabel printed log JSON as downloaded native artifact bytes.
- Both historical unknowns are retained. The report cannot approve G0/G1, rewrite the historical audit waiver, grant release authority, execute a transaction or deploy anything.
- Model notes are historical interpretation only. Extra authority fields are rejected. Text is escaped in HTML; the page has no scripts, external resources, forms or commands.
- Private evidence packets, owner records, private source and credentials stay outside this public review branch. The example and GitHub test artifacts contain synthetic data only.

## Synthetic demonstration

```bash
node releaseproof/write-example.mjs releaseproof-example
node releaseproof/cli.mjs --expected releaseproof-example/expected.json --packet releaseproof-example/packet.json --out releaseproof-output
```

Open `releaseproof-output/review.html`. It shows five synthetic High records, successful command execution, a failed QC verdict, incomplete native provenance and pending human release approval.

## Code QC

The isolated GitHub branch runs `node --test releaseproof/report.test.mjs`. Its checks cover identity binding, malformed/missing data, failed/skipped execution, tampered raw bytes, inconsistent findings, retained unknowns, forged approvals, deterministic output, escaped HTML and CLI behavior. No local or GitLab code-QC run is substituted for those GitHub results. A passing report-code check does not accept private artifact provenance or approve the full application release.

The branch's `vercel.json` disables automatic Git deployment. The GitHub workflow has contents-read permission, no deployment job, no provider credentials and no model invocation. It never runs the original Next.js build or changes the original application release.
