import fs from 'node:fs';
import path from 'node:path';
import {escapeHtml as e} from './report.mjs';

// Only these literal destinations may be inspected or linked. Receipt paths/URLs
// are inert evidence text, never filesystem selectors or HTML attributes.
export const DEMO_FILES = Object.freeze([
  'receipt.json', 'WALKTHROUGH.md', 'valid-input/packet.json', 'valid-input/expected.json',
  'negative-packet.json', 'recovery-packet.json', 'producer.stdout', 'producer.stderr',
  'negative.stdout', 'negative.stderr', 'recovery.stdout', 'recovery.stderr',
  'recovery-output/review.json', 'recovery-output/review.html',
]);

export function observeDemoFiles(root) {
  return new Set(DEMO_FILES.filter(name => {
    // Reject links in every component; do not follow an artifact outside the bundle.
    let current = root;
    try {
      for (const component of name.split('/')) {
        current = path.join(current, component);
        if (fs.lstatSync(current).isSymbolicLink()) return false;
      }
      return fs.lstatSync(current).isFile();
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
      throw error;
    }
  }));
}

export function renderDemoPage(receipt, available = new Set()) {
  const value = item => item === undefined || item === null ? 'Unavailable' : String(item);
  const text = item => e(value(item));
  const link = name => available.has(name)
    ? `<a href="${name}">${name}</a>` : `<span>${name} — unavailable</span>`;
  const links = names => `<ul>${names.map(name => `<li>${link(name)}</li>`).join('')}</ul>`;
  const attempts = Array.isArray(receipt.attempts) ? receipt.attempts : [];
  const attempt = id => attempts.find(item => item.id === id);
  const negative = attempt('negative');
  const recovery = attempt('recovery');
  const exited = (item, exit) => item?.exit_code === exit && item.signal === null && item.spawn_error === null;
  const rejected = exited(negative, 2) && negative.outcome === 'SYNTHETIC_REQUIRED_ARTIFACT_REJECTED';
  const recovered = exited(recovery, 0) && recovery.outcome === 'SYNTHETIC_REPORT_GENERATED_WITH_FINDINGS';
  const complete = receipt.outcome === 'SYNTHETIC_DEMONSTRATION_PASSED' && !receipt.failure && rejected && recovered &&
    receipt.recovery_boundary && receipt.recovery_byte_identity_established === true && available.has('receipt.json') && available.has('recovery-output/review.json') && available.has('recovery-output/review.html');
  const status = item => {
    if (!item) return 'NOT RUN';
    if (item.spawn_error || item.signal) return 'PROCESS FAILURE';
    if (item.id === 'producer' && exited(item, 0)) return 'SUCCEEDED';
    if (item.id === 'negative' && rejected) return 'SYNTHETIC_REQUIRED_ARTIFACT_REJECTED';
    if (item.id === 'recovery' && recovered) return 'SYNTHETIC_REPORT_GENERATED_WITH_FINDINGS';
    return 'FAILED / INCOMPLETE';
  };
  const processTable = (item, label) => `<table><caption>${label} — observed process result</caption><thead><tr><th scope="col">Field</th><th scope="col">Observed value</th></tr></thead><tbody>${[
    ['Status', status(item)], ['Exit code', item?.exit_code], ['Signal', item?.signal ?? (item ? 'None recorded' : undefined)],
    ['Spawn error', item?.spawn_error ?? (item ? 'None recorded' : undefined)],
    ['Recorded output directory (inert text)', item?.output_directory],
    ['Observed output file names (inert text)', item?.output_files ? JSON.stringify(item.output_files) : undefined],
  ].map(([label, item]) => `<tr><th scope="row">${label}</th><td class="evidence">${text(item)}</td></tr>`).join('')}</tbody></table>`;
  const identities = [['Original valid packet', 'valid'], ['Separate trusted expectation', 'expected'], ['Negative packet', 'negative'], ['Recovery packet', 'recovery']];
  const boundary = receipt.recovery_boundary;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>ChangeGate · Synthetic demo walkthrough</title>
<style>
body{margin:0;background:#f3f5f8;color:#182330;font:16px/1.55 system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:40px 24px}h1{margin:0;font-size:34px;letter-spacing:-.8px}h2{font-size:20px;margin:24px 0 12px}.eyebrow{font-weight:700;color:#405a78;letter-spacing:1px;font-size:12px}.muted{color:#526174}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:24px 0}.card,section{background:white;border:1px solid #d9e0e8;border-radius:12px;padding:18px}.card small{display:block;color:#526174}.warning{border-left:5px solid #b56112;padding:14px 18px;background:#fff5e7;border-radius:6px}table{width:100%;border-collapse:collapse;font-size:14px;table-layout:fixed}caption{text-align:left;font-weight:700;margin:12px 0}th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #e2e7ed}a{color:#1d4f86;text-decoration:underline}a:focus-visible{outline:3px solid #1d4f86;outline-offset:4px;border-radius:2px}main,li,td,th,code,.card{overflow-wrap:anywhere;min-width:0}.evidence{white-space:pre-wrap}code{font-size:14px}ol.stages{padding-left:24px}ol.stages>li{margin:24px 0}footer{margin-top:24px;font-size:14px}@media(max-width:480px){main{padding:24px 12px}h1{font-size:28px}th,td{padding:6px}section{padding:12px}}@media print{body{background:white;color:black}main{max-width:none;padding:0}.card,section{border-color:#777;box-shadow:none}.warning{background:white;border-color:black}a{color:black}a::after{content:' (' attr(href) ')';font-size:12px}.cards{display:block}.card{margin:8px 0}h2,caption{break-after:avoid}tr{break-inside:avoid}}
</style></head><body><main>
<header><p class="eyebrow">CHANGEGATE RELEASEPROOF · SYNTHETIC</p><h1>Synthetic rejection and recovery walkthrough</h1>
<p>Intended sequence: omit the required <code>validation_exits_raw</code> field from an invented evidence packet, then restore it from the original packet in a separate attempt. Observed process results below show which attempts actually ran.</p></header>
<div class="warning"><strong>SYNTHETIC evidence only. Human release approval is pending; deployment.authorized=false.</strong> This is not live-provider recovery, clean native QC, deployment verification, approval or production release. G0 OPEN / NOT APPROVED; G1 CLOSED.</div>
<div class="cards"><div class="card"><small>Bundle status</small><strong>${complete ? 'SYNTHETIC DEMONSTRATION COMPLETED' : 'FAILED / INCOMPLETE'}</strong></div><div class="card"><small>Receipt outcome</small><strong class="evidence">${text(receipt.outcome)}</strong></div></div>
${receipt.failure ? `<section aria-labelledby="failure"><h2 id="failure">Recorded failure</h2><p class="evidence">${text(receipt.failure)}</p></section>` : ''}
<p>The page presents the retained run receipt and files observed when it was generated. It is not a new report validator or authenticated provider proof. Available files on a failed run are evidence for inspection, not proof of recovery.</p>
<nav aria-label="Retained machine receipt and Markdown walkthrough">${links(['receipt.json', 'WALKTHROUGH.md'])}</nav>
<ol class="stages">
<li><section aria-labelledby="inputs"><h2 id="inputs">Inputs: preserve the synthetic originals</h2><p>The expectation is separate from the packet. The intended negative packet removes only <code>validation_exits_raw</code> and retains the remaining provenance. Inspect the available inputs and observed attempts below.</p>
${links(['valid-input/packet.json', 'valid-input/expected.json', 'negative-packet.json', 'producer.stdout', 'producer.stderr'])}
${processTable(attempt('producer'), 'Fixture producer')}
<table><caption>Retained input byte identities</caption><thead><tr><th scope="col">Input</th><th scope="col">Recorded path (inert text)</th><th scope="col">SHA-256</th><th scope="col">Bytes</th></tr></thead><tbody>${identities.map(([label, key]) => {
    const identity = receipt.inputs?.[key];
    return `<tr><th scope="row">${label}</th><td class="evidence">${text(identity?.path)}</td><td class="evidence">${text(identity?.sha256)}</td><td>${text(identity?.byte_count)}</td></tr>`;
  }).join('')}</tbody></table></section></li>
<li><section aria-labelledby="rejection"><h2 id="rejection">Rejected attempt: required evidence is missing</h2><p>${rejected ? 'The runner recorded the required-artifact rejection: exit 2, the missing-field diagnostic and no generated review outputs.' : 'Required-artifact rejection has not been established. Inspect the observed status and retained logs; a process error is a demo failure.'}</p>
${processTable(negative, 'Negative CLI attempt')}${links(['negative.stdout', 'negative.stderr'])}<p>Empty output directories are not retained in ZIP files. The receipt records the observed listing.</p></section></li>
<li><section aria-labelledby="correction"><h2 id="correction">Single correction: restore the omitted field</h2><p>Recovery is designed to use the preserved original valid packet, restoring only <code>validation_exits_raw</code>; it does not change validation rules or clear findings.</p><p>Observed byte relationship: <strong>${receipt.recovery_byte_identity_established === true ? 'Runner established recovery packet byte-identical to original.' : 'Not established; do not assume byte-identical recovery.'}</strong></p><p class="evidence">Recorded correction: ${text(receipt.correction)}</p>${links(['recovery-packet.json'])}</section></li>
<li><section aria-labelledby="recovery"><h2 id="recovery">Recovery attempt: report generation only</h2>
${processTable(recovery, 'Recovery CLI attempt')}${links(['recovery.stdout', 'recovery.stderr', 'recovery-output/review.json', 'recovery-output/review.html'])}
${complete ? `<h3>Retained synthetic release limits</h3><p>Report generation succeeded while the underlying QC verdict remains failed. Five synthetic High findings remain visible in the report.</p><table><caption>Boundary recorded after successful demonstration</caption><thead><tr><th scope="col">Field</th><th scope="col">Recorded value</th></tr></thead><tbody>${[
    ['QC verdict', boundary.qc_verdict], ['Artifact provenance', boundary.provenance_status], ['Synthetic High findings', boundary.synthetic_high_findings],
    ['Human release status', boundary.human_release?.status], ['Human release approved', boundary.human_release?.approved], ['Deployment authorized', boundary.deployment?.authorized],
  ].map(([label, item]) => `<tr><th scope="row">${label}</th><td class="evidence">${text(item)}</td></tr>`).join('')}</tbody></table>` : '<p><strong>Recovery boundary unavailable.</strong> This bundle does not establish a completed successful demonstration. No recovery or approval is inferred from partial files or exit code alone.</p>'}
</section></li></ol>
<section aria-labelledby="github"><h2 id="github">Actual GitHub execution identity</h2>${receipt.github ? `<dl>${[['Repository', receipt.github.repository], ['SHA', receipt.github.sha], ['Run ID', receipt.github.run_id], ['Attempt', receipt.github.attempt], ['Recorded run URL (inert text)', receipt.github.url]].map(([label, item]) => `<dt>${label}</dt><dd class="evidence">${text(item)}</dd>`).join('')}</dl>` : '<p>Unavailable — no GitHub Actions identity was recorded. Outside Actions, no SHA, run or attempt is invented.</p>'}<p class="muted">GitHub identity identifies this report-code execution only. All provider-like input identities are synthetic.</p></section>
<footer><p>G0 OPEN / NOT APPROVED · G1 CLOSED. Supervisor acceptance and any release decision remain separate human actions.</p></footer>
</main></body></html>\n`;
}
