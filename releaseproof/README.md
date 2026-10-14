# ReleaseProof review report v1

This standalone module produces deterministic JSON and an offline HTML review of an exact evidence packet. It uses Node.js built-ins and adds no package dependency. It does not change the ChangeGate application, seven WebMCP tools, approval/execute controls or historical offline verifier.

## Use

```bash
node releaseproof/cli.mjs --expected trusted-expectation.json --packet evidence-packet.json --out review-output
```

The expectation file comes from the human collector, separately from model text and evidence. It fixes the project, commit, pipeline, all five job IDs and explicit calendar-valid UTC review time. Optional `owner_disposition` records a bounded human risk decision; this report does not authenticate the record. A supplied `pipeline` must match the reviewed pipeline. A legacy decision without that binding is preserved as `UNBOUND_PIPELINE`, with its original supplied status, scope, expiry and advisory IDs; no pipeline is invented and it is not labelled acceptance of the current execution. See `fixtures.mjs` for a synthetic contract example.

Outputs are `review.json` and `review.html`. Exit 0 means report generation succeeded; it does **not** mean the pipeline passed or release was approved. Invalid evidence returns exit 2 before creating outputs.

The input contract is `releaseproof-packet/v1`; trusted expectation is `releaseproof-expectation/v1`; output is `releaseproof-review/v1`. Use explicit `reviewed_at`, not an implicit clock, so identical inputs produce identical bytes.

CLI envelopes require well-formed UTF-8 before JSON parsing. Malformed byte sequences are rejected rather than replaced with U+FFFD; valid Unicode is preserved without normalization. Evidence records and advisory IDs must contain a non-whitespace character. Validation never trims or rewrites accepted evidence strings.

After JSON parsing, every string value and object key is checked for unpaired UTF-16 surrogates, including nested objects and arrays and raw artifact documents. Lone high/low surrogates and broken pairs are rejected rather than replaced. Valid surrogate pairs, valid literal Unicode and literal text such as a backslash followed by `ud800` remain unchanged. The public object-based report API applies the same validation when callers parsed JSON separately.

U+0000 is also rejected in string values and object keys, including direct report-renderer inputs, before any HTML is produced. Evidence records, advisory/finding IDs and accepted advisory IDs are rendered as separate escaped list items. Commas and line breaks inside an identifier remain inside that item; they are never treated as separators or used to rewrite the source evidence.

Optional `target_count` is retained in each normalized finding row and displayed in the HTML's Target findings column. A missing field remains absent in JSON and displays `Not supplied`; a supplied zero remains `0` in both outputs. Supplied values must still be nonnegative safe integers no greater than that row's finding count.

A pipeline-bound risk decision is active only while `reviewed_at < expires_at`. At the expiry instant and afterwards (`reviewed_at >= expires_at`), its status is `EXPIRED`. A missing pipeline binding remains `UNBOUND_PIPELINE`; it is never attributed to the reviewed execution.

## Evidence boundary

- Successful application and scanner/audit execution is required. Findings are separate from command execution. A full audit exit 1 with findings can be a valid completed audit.
- A failed assessment and failed pipeline remain failed when complete evidence explains the findings. Zero findings require successful native assessment/pipeline records.
- Raw-file SHA-256 and byte counts are checked. These establish integrity within the supplied packet, not provider authenticity. `native-artifact` is a collector-supplied provenance label; it is reported as `NATIVE_BYTES_DECLARED` and never as a signed attestation.
- JSON input envelopes and raw artifacts reject duplicate object member names, including escaped aliases. QC summaries and their result/execution/coverage/findings/severity objects reject unexpected fields. Embedded job pipeline statuses must agree with the completed top-level pipeline receipt.
- Full and production audit findings are compared only when both audit results supply matching `snapshot` objects with `lockfile_sha256` and `advisory_snapshot_sha256`. These declare the same underlying dependency lockfile and advisory snapshot; a shared audit job ID alone does not establish comparability. Under that explicit assumption, production records and advisory IDs must be subsets, and counts and each severity total cannot exceed the full audit. The identities are collector declarations, not provider authentication. Missing identities produce `NOT_ESTABLISHED`; different identities produce `DIFFERENT_SNAPSHOTS`; both yield `INCOMPLETE_AUDIT_COMPARABILITY` rather than `PASSED` consistency. Do not populate these identities without evidence. Synthetic fixtures declare only synthetic snapshots.
- The HTML audit-comparability section displays escaped lockfile and advisory-snapshot hashes for both audits. Matching declarations appear under both audit names; different declarations remain separate. A supplied identity remains visible when the other audit is unknown, and missing identities are labelled as not supplied without changing the incomplete comparability state.
- Trace-derived and synthetic inputs remain `INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE`. Do not relabel printed log JSON as downloaded native artifact bytes.
- Both historical unknowns are retained. The report cannot approve G0/G1, rewrite the historical audit waiver, grant release authority, execute a transaction or deploy anything.
- Model notes are historical interpretation only. Extra authority fields are rejected. Text is escaped in HTML; the page has no scripts, external resources, forms or commands.
- Historical model capture time cannot postdate the explicit review time. Risk scope, expiry, accepted advisory IDs and pipeline binding are visible in HTML as well as JSON. Missing bindings do not revoke or expand the original human decision.
- CLI reads remain bounded to 32,768 expectation bytes and 1,048,576 packet bytes, with at most one extra byte to detect oversize. Input and output-to-output alias identities are checked before staging and again before publication. Destination files are never opened for writing or truncated.
- Private evidence packets, owner records, private source and credentials stay outside this public review branch. The example and GitHub test artifacts contain synthetic data only.

## Synthetic demonstration

```bash
node releaseproof/write-example.mjs releaseproof-example
node releaseproof/cli.mjs --expected releaseproof-example/expected.json --packet releaseproof-example/packet.json --out releaseproof-output
```

Open `releaseproof-output/review.html`. It shows five synthetic High records, successful command execution, a failed QC verdict, incomplete native provenance and pending human release approval.

## Trusted output directory

The collector must choose an output directory whose resolved path and ancestor directories are trusted against concurrent rename, replacement or modification by other actors for the duration of the command. The CLI resolves the directory once after creation. Portable Node path APIs do not provide a directory-descriptor-relative publication guarantee against an attacker replacing directory entries concurrently; this command is not a writer for a hostile shared directory.

Each report is staged in that resolved directory using a random name, exclusive `wx` creation and mode `0600`. Contents are written through the created descriptor, flushed and closed before publication. An existing temporary name, including a symlink, causes exclusive creation to fail rather than following or overwriting it. Only successfully created temporary files are owned by this invocation.

Same-directory atomic rename replaces the destination entry rather than writing through its existing symlink or hard link. Unrelated linked targets retain their original bytes. Input aliases and aliases between the two outputs are rejected; existing ordinary reports can be replaced. Remaining owned temporary files are removed on failure, and a file that caused an exclusive-create collision is left untouched. No destination is opened based on a preceding link check.

Each file replacement is atomic; the JSON/HTML pair is not a transaction. Both files are fully staged before either rename. If the second rename fails, the JSON may already be replaced while the previous HTML remains. The CLI returns exit 2 and removes the unpublished temporary file. Inspect the failure and rerun in the trusted directory; no partial file content is published.

## Code QC

The isolated GitHub branch runs `node --test releaseproof/report.test.mjs releaseproof/cli.test.mjs releaseproof/corrections.test.mjs releaseproof/output.test.mjs releaseproof/input-review.test.mjs releaseproof/unicode.test.mjs releaseproof/evidence-items.test.mjs`. It retains all 252 existing tests and adds focused synthetic regressions for review 5525472023. No local or GitLab code-QC run is substituted for those GitHub results. A passing report-code check does not accept private artifact provenance or approve the full application release.

The branch's `vercel.json` disables automatic Git deployment. The GitHub workflow has contents-read permission, no deployment job, no provider credentials and no model invocation. It never runs the original Next.js build or changes the original application release.
