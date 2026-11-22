import Link from "next/link";
import styles from "../merchant.module.css";

export default function CaseNotFound() {
  return <main className={styles.shell}>
    <div className={styles.card}>
      <h1>Case unavailable</h1>
      <p>This case could not be opened in your workspace.</p>
      <Link href="/merchant">Return to merchant workspace</Link>
    </div>
  </main>;
}
