import type { Metadata } from "next";
import Link from "next/link";
import styles from "../page.module.css";

export const metadata: Metadata = {
  title: "ReleaseProof SYNTHETIC demo | ChangeGate",
  description: "Inspect retained synthetic missing-evidence rejection and separate report-generation recovery.",
};

export default function ReleaseProofPage() {
  return (
    <div className={styles.page}>
      <nav className={styles.releaseproofNavigation} aria-label="ChangeGate navigation">
        <Link href="/">Refund control console</Link>
        <a href="#evidence">Skip to synthetic evidence</a>
      </nav>
      <main id="evidence" className={styles.releaseproofContent}>
        <p className={styles.eyebrow}>ChangeGate ReleaseProof · SYNTHETIC</p>
        <h1>Inspect evidence rejection and report-generation recovery</h1>
        <p>This build-generated demonstration works in an ordinary browser without WebMCP. It uses invented evidence and the real ReleaseProof CLI. It demonstrates report generation, not deployment recovery.</p>
        <section aria-labelledby="sequence">
          <h2 id="sequence">Intended sequence — inspect what actually ran</h2>
          <ol>
            <li>Preserve a synthetic valid packet and a separate trusted expectation, with byte identities.</li>
            <li>Omit only <code>validation_exits_raw</code> and invoke the CLI in a fresh negative directory.</li>
            <li>Restore the original packet bytes in a separate recovery attempt.</li>
            <li>Read the actual exits, process errors, retained inputs and recovery outputs in the walkthrough and machine receipt.</li>
          </ol>
          <p><a className={styles.evidenceLink} href="/releaseproof-demo/index.html">Open retained synthetic walkthrough</a></p>
          <p>The walkthrough links to packet inputs, <code>receipt.json</code>, the negative diagnostic, Markdown instructions and recovery JSON/HTML. If any evidence is missing, recovery is not established. This landing page itself makes no completed-demo or QC claim.</p>
        </section>
        <section aria-labelledby="limits">
          <h2 id="limits">Report generation never authorizes release</h2>
          <p>Even a successfully verified demonstration retains five synthetic High findings, <code>FAILED_WITH_FINDINGS</code>, <code>INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE</code>, human release <code>PENDING</code> and <code>deployment.authorized=false</code>.</p>
          <p>Actual GitHub identity is shown only when recorded by the generating Actions run. A build elsewhere is not GitHub QC, provider proof, clean native QC, deployment verification or release approval.</p>
          <p><strong>G0 OPEN / NOT APPROVED · G1 CLOSED.</strong> Supervisor acceptance and human release decisions remain separate.</p>
        </section>
      </main>
    </div>
  );
}
