import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { demoMerchant } from "../../merchant-team/demo-shift";
import { teamWorkspace } from "../../merchant-team/runtime";
import styles from "../merchant/merchant.module.css";

export const dynamic = "force-dynamic";

// Redacted snapshot of the hosted acceptance run. This page does not look up a payment.
const verificationTime = "2026-11-23T00:36:13.185Z";

export default async function VerifiedSquareExamplePage() {
  const mode = process.env.CHANGEGATE_TEAM_MODE;
  if (mode !== "demo" && mode !== "railway-demo") notFound();
  const employee = teamWorkspace()?.employeeFor(await headers());
  if (!employee) redirect("/shift-overview");
  if (employee.merchantId !== demoMerchant || employee.role === "reviewer") notFound();

  return <main className={styles.shell}>
    <header className={styles.header}>
      <div>
        <p className={styles.brand}>ChangeGate</p>
        <h1>Recorded Square Sandbox result</h1>
      </div>
      <Link href="/shift-overview" prefetch={false}>Back to Shift Overview</Link>
    </header>
    <section className={`${styles.card} ${styles.shiftOverview}`} aria-label="Recorded refund timeline">
      <div>
        <p>Read-only snapshot from a separate Square Sandbox test.</p>
        <p className={styles.fieldHint}>Verified <time dateTime={verificationTime}>November 22, 2026 at 7:36:13 p.m. Eastern</time></p>
      </div>
      <ol className={styles.evidenceRows}>
        <li className={styles.evidenceRow}>
          <p className={styles.evidenceLabel}>Original sale</p>
          <strong className={styles.sourceAmount}>$75.00</strong>
        </li>
        <li className={styles.evidenceRow}>
          <p className={styles.evidenceLabel}>During the hold</p>
          <strong className={styles.sourceAmount}>0 refunds</strong>
        </li>
        <li className={styles.evidenceRow}>
          <p className={styles.evidenceLabel}>Supervisor decision</p>
          <strong className={styles.sourceAmount}>Jordan approved $52.00</strong>
        </li>
        <li className={styles.evidenceRow}>
          <p className={styles.evidenceLabel}>Independent Square verification after restart</p>
          <strong className={styles.sourceAmount}>One completed $52.00 refund</strong>
          <p>$23.00 still refundable</p>
        </li>
      </ol>
    </section>
  </main>;
}
