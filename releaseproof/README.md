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

The HTML escaper encodes each carriage return as `&#13;` while retaining line feeds. HTML input preprocessing therefore cannot collapse CR, LF and CRLF evidence into the same text. The normalized JSON and input evidence are unchanged. Historical model provenance displays its own `source.input_sha` as the Historical model input commit, or explicitly `Not supplied`; this is a separate field from the Reviewed commit in the page header.

Optional `target_count` is retained in each normalized finding row and displayed in the HTML's Target findings column. A missing field remains absent in JSON and displays `Not supplied`; a supplied zero remains `0` in both outputs. Supplied values must still be nonnegative safe integers no greater than that row's finding count.

A pipeline-bound risk decision is active only while `reviewed_at < expires_at`. At the expiry instant and afterwards (`reviewed_at >= expires_at`), its status is `EXPIRED`. A missing pipeline binding remains `UNBOUND_PIPELINE`; it is never attributed to the reviewed execution.

## Evidence boundary

The `native` section is a closed collector-supplied identity receipt, using the shapes in `fixtures.mjs`; it is not an unrestricted raw provider API response. Required keys are:

| Object | Required keys | Optional keys |
| --- | --- | --- |
| `native` | `project`, `commit`, `pipeline`, `jobs` | None |
| `native.project` | `id` | None |
| `native.commit` | `id` | None |
| `native.pipeline` | `id`, `project_id`, `sha`, `status` | None |
| Each native job | `id`, `name`, `status`, `commit`, `pipeline` | `project` |
| Job `project`, when supplied | `id` | None |
| Job `commit` | `id` | None |
| Job `pipeline` | `id`, `project_id`, `sha`, `status` | None |

Every object must have the stated shape; unexpected fields, including approval/deployment claims, are rejected before report generation. Project/commit/pipeline/job identities must match the separate trusted expectation, including an optional job project. Omitting that optional object never fabricates one. Existing completed-status, execution and failed-findings checks still apply. Validation leaves supplied input bytes/objects unchanged, and the normalized report contract is unchanged.

A full raw provider response containing extra fields (for example a project `web_url` or job `artifacts`) is outside this native receipt shape and is rejected, not silently stripped or authenticated. Existing producer-compatibility cases cover QC-summary execution and analyzer/scanner metadata; that supported metadata and its original byte/digest checks remain intact. This change does not claim compatibility with unmodelled provider receipt metadata. Any such compatibility requirement needs an explicit evidence-grounded schema decision; do not remove fields from retained original evidence to bypass rejection.

- Producer execution objects may optionally supply `issues`, which must be exactly an empty array. SAST execution may also supply `target_exit`, which must be the number `0`. Nonempty issues, nonzero exits and unsupported types are unsuccessful or incomplete evidence and fail report generation. These optional fields are retained as `execution_issues` and `target_exit` in the normalized finding row and displayed in HTML; absence remains absence in JSON.
- SAST findings may optionally supply `details` only as `[]` when `count` is zero. The empty array is preserved in JSON and HTML. Nonempty arrays, objects and other shapes are unsupported; this does not define a details contract for nonzero findings.
- SAST and secrets results may optionally supply independent `analyzer` and `scanner` objects. Each supplied object requires exactly `id`, `name`, `url`, `vendor` and `version`; `vendor` requires exactly `name`. All values are nonblank strings, bounded to 256 UTF-16 code units per field except `url` (2,048). They are validated without trimming or normalization, copied into the normalized finding row and rendered as individually labelled escaped HTML text. URLs are opaque evidence text, never links or resource addresses. These metadata declarations confer no authenticity or approval authority. Unknown keys are rejected at every new object boundary; existing minimal summaries remain supported.
- Compatibility validation reads the supplied raw summary without modifying it or its provenance. SHA-256 and byte-count checks still apply to the original supplied raw string, including its whitespace. No compatibility adapter strips fields, rewrites evidence or fills missing audit snapshot identities.
- Dependency finding counts require an empty `advisory_ids` list at zero and a nonempty list above zero. Advisory IDs do not need a one-to-one relationship with affected package records. When matching lockfile/advisory snapshots establish comparability and both audits supply `target_count`, the production target count cannot exceed the full count. A missing count remains absent, and zero remains supplied; missing or differing snapshots never establish target-count comparability.
- The HTML findings table displays the numeric dependency `command_exit` in its own column, separately from successful wrapper execution. Nondependency rows display `Not applicable`. The risk section displays the retained record-authenticity limitation and states that the supplied owner record is not authenticated by this report; acceptance bounds and pending human release approval are unchanged.
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

The isolated GitHub branch runs `node --test releaseproof/report.test.mjs releaseproof/cli.test.mjs releaseproof/corrections.test.mjs releaseproof/output.test.mjs releaseproof/input-review.test.mjs releaseproof/unicode.test.mjs releaseproof/evidence-items.test.mjs releaseproof/html-provenance.test.mjs releaseproof/producer-compat.test.mjs releaseproof/audit-risk-review.test.mjs`. It retains all 444 existing tests, including producer-compatibility regressions, and adds focused synthetic regressions for review 5527450261. No local or GitLab code-QC run is substituted for those GitHub results. A passing report-code check does not accept private artifact provenance or approve the full application release.

The branch's `vercel.json` disables automatic Git deployment. The GitHub workflow has contents-read permission, no deployment job, no provider credentials and no model invocation. It never runs the original Next.js build or changes the original application release.

The existing boolean `git.deploymentEnabled: false` has a global effect if merged. It is deliberately preserved as the deployment-off safeguard on this review branch. Review finding 4277018243 remains an open pre-merge scope decision for the supervisor; this correction does not enable or reconfigure deployment.

## SYNTHETIC missing-artifact rejection and recovery

The existing GitHub report-QC workflow runs `node releaseproof/demo.mjs releaseproof-output/demo` and uploads the demo with the existing report artifact, including on failure. All code/security QC remains exclusively in GitHub. The runner uses the existing fixture producer and real CLI; it changes no validation rules.

Extract the artifact and open `demo/index.html` first for the offline sequence and links to available retained files. Keep `demo/WALKTHROUGH.md` and `demo/receipt.json` as the readable and machine-readable fallbacks. The retained valid packet and separate expectation have byte counts and SHA-256 digests. The negative packet omits only required `validation_exits_raw`; its fresh output directory must remain empty, with actual CLI exit 2 and the missing-field diagnostic. A spawn/process error fails the demonstration. Empty directories are not represented in ZIP artifacts; the receipt records the observed empty directory listing. Recovery uses the original valid packet bytes in a distinct input file and separate output directory, requiring real exit 0 and valid JSON/HTML. Both attempts retain stdout/stderr and input identities. Reusing the demo root is rejected to prevent stale evidence.

The receipt records actual Actions repository/SHA/run/attempt when running in Actions, and `github: null` otherwise. A failure exits nonzero and preserves its receipt and walkthrough. All fixture identities and all demonstrated evidence/outcomes are SYNTHETIC; GitHub execution identity identifies only the report-code run. A generated report retains five visible synthetic High findings, `FAILED_WITH_FINDINGS`, incomplete native provenance, pending human release and `deployment.authorized=false`. This is report-generation recovery only, never clean native QC, deployment verification, human approval or production release. G0 remains OPEN / NOT APPROVED; G1 remains CLOSED. Supervisor acceptance and any security review remain separate.

The entry page presents the actual completed or partial receipt and observed availability of fixed known bundle files. Missing artifacts are labelled unavailable; receipt paths and GitHub URLs are inert text. Failed/incomplete runs never receive a completed recovery boundary. The page uses the existing HTML escaping and offline CSP, with no scripts, network resources or dependencies. Entry-page write failures exit nonzero while preserving the original demo failure and independently retaining the receipt and Markdown where writable. No browser or visual QC was performed in the Codex environment; acceptance checks run only in GitHub.

## Hosted ordinary-browser fallback

The application homepage links to `/releaseproof`. That landing page explains the intended sequence and limits without asserting a completed outcome. Open `/releaseproof-demo/index.html` for the actual generated receipt-based walkthrough; its fixed links expose original/negative/recovery inputs, the separate expectation, `receipt.json`, stdout/stderr (including the negative diagnostic), Markdown, and recovery JSON/HTML. No WebMCP support is required. No commands or providers run in response to a browser request.

`npm run build` first runs `releaseproof/hosted-build.mjs`, using the existing real fixture producer and CLI demonstration, then builds Next.js. The generator exclusively owns `public/releaseproof-demo/`, `work/releaseproof-hosted-demo/` and `work/releaseproof-hosted-publication/`. It removes the old public bundle before fresh generation, preserves partial attempt evidence under its work directory on failure, copies only an explicit fixed file allowlist, and publishes only after successful generation and presence checks. It never copies an unrelated artifact directory. A failed generation exits nonzero, removes owned public/staging output and prevents the production build; stale success evidence is not retained there. Other public and work paths remain untouched. Generated receipts are ignored by Git and must not be committed as current validation. Fixed inputs and execution identity yield reproducible bundle bytes; actual Actions identity differs between runs by design.

The public HTML retains its no-script offline CSP; the public bundle also receives restrictive CSP, `nosniff` and `no-store` response headers. The landing route uses ordinary application rendering and accessible links. This is a static build snapshot, not live-provider proof or monitoring: outside Actions, GitHub identity remains unavailable. A build on another host is never relabelled GitHub QC. Missing evidence cannot establish completion; the build fails rather than publishing an incomplete bundle. Opening an absent static asset returns an error, not recovery evidence.

The existing GitHub workflow retains all report tests and adds generator ownership/stale-output/failure tests. A separate contents-read job installs existing locked dependencies, runs existing application/authority tests, builds production, typechecks, lints changed integration sources, and runs isolated pinned Chromium smoke checks at the exact Actions SHA. Browser receipts, logs, a narrow-screen screenshot and the generated/partial synthetic bundle are retained on failure as well as success. These checks run exclusively in GitHub, not in Codex or GitLab. The screenshot supports route smoke inspection; it is not a claim of a full visual or accessibility audit.

This increment uses only the public PR. The separate private GitLab application has not been reconciled or imported. `vercel.json` remains deployment-disabled. No deployment, merge, access change, provider credentials, real evidence, human release or gate approval is performed. Hosted **report-generation** recovery retains five synthetic High findings, failed QC, incomplete provenance and pending human release; it is not the later wrong-deployed-version detection/recovery feature. G0 OPEN / NOT APPROVED; G1 CLOSED. Reconciliation, any staging/deployment decision and final video remain separate supervisor work.
