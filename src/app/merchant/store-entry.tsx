import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./merchant.module.css";

export function StoreEntry({ children }: { children?: ReactNode }) {
  return <main className={styles.shell}>
    <div className={styles.entryShell}>
      <header className={styles.entryHeader}>
        <Link href="/" className={styles.entryBrand}>ChangeGate</Link>
        <span>Midtown Intelligence Labs</span>
      </header>
      <div className={styles.entryGrid} data-sign-in={Boolean(children)}>
        <section className={styles.entryIntro}>
          <h1>Review risky refunds before payout</h1>
          <p>Check a refund against the original sale. When a request exceeds a store limit, a supervisor reviews the evidence and makes the decision.</p>
          <p className={styles.entryMode}>Staging · Test sales only</p>
          {!children&&<Link className={styles.primary} href="/transactions">Merchant sign-in</Link>}
        </section>
        {children??<aside className={styles.entrySide}>
          <h2>Example at the register</h2>
          <dl className={styles.entryExample}>
            <div><dt>Requested refund</dt><dd>$42.00</dd></div>
            <div><dt>Remaining refundable</dt><dd>$24.00</dd></div>
          </dl>
          <p className={styles.entryOutcome}>Blocked at Checks</p>
          <p>The cashier can see why the request stopped. The record stays available for the store’s weekly review.</p>
        </aside>}
      </div>
    </div>
  </main>;
}
