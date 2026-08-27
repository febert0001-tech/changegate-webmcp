"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  createChangeGateOperations,
  createWebMcpOperationsFacade,
} from "../application/changegate-operations";
import { getWebMcpModelContext } from "../webmcp/native-contract";
import { startWebMcpRegistration } from "../webmcp/registration";
import styles from "./page.module.css";

type Availability = "CHECKING" | "AVAILABLE" | "UNSUPPORTED" | "FAILED";

const LABELS: Readonly<Record<Availability, string>> = Object.freeze({
  CHECKING: "Checking browser support",
  AVAILABLE: "Seven safe tools registered",
  UNSUPPORTED: "WebMCP unavailable in this browser",
  FAILED: "WebMCP registration unavailable",
});

export function ChangeGateWebMcp() {
  const [operations] = useState(() => createChangeGateOperations());
  const [webMcpOperations] = useState(() => createWebMcpOperationsFacade(operations));
  const [availability, setAvailability] = useState<Availability>("CHECKING");
  useSyncExternalStore(operations.subscribe, operations.getRevision, operations.getRevision);

  const proposal = operations.getChangeProposal();

  useEffect(() => {
    let mounted = true;
    const modelContext = getWebMcpModelContext(document);
    const session = startWebMcpRegistration(modelContext, webMcpOperations);

    void session.ready.then((result) => {
      if (!mounted) return;
      if (result.status === "REGISTERED") setAvailability("AVAILABLE");
      else if (result.status === "UNSUPPORTED") setAvailability("UNSUPPORTED");
      else setAvailability("FAILED");
    });

    return () => {
      mounted = false;
      session.dispose();
    };
  }, [webMcpOperations]);

  return (
    <>
      <p className={styles.integrationStatus} role="status" aria-live="polite">
        WebMCP: {LABELS[availability]}
      </p>
      <section className={styles.authorizationPanel} aria-labelledby="authorization-heading">
        <div className={styles.authorizationHeading}>
          <div>
            <p className={styles.authorizationKicker}>Human authorization</p>
            <h3 id="authorization-heading">Change review</h3>
          </div>
          <strong className={styles.authorizationStatus}>
            {proposal?.lifecycle.replaceAll("_", " ") ?? "NONE"}
          </strong>
        </div>

        {proposal === null ? (
          <p className={styles.authorizationMessage}>
            No proposal is available for human review.
          </p>
        ) : (
          <>
            <dl className={styles.proposalSummary}>
              <div>
                <dt>Proposal ID</dt>
                <dd><code>{proposal.proposalId}</code></dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd>{proposal.target}</dd>
              </div>
              <div>
                <dt>Proposed change</dt>
                <dd><code>{proposal.action}</code></dd>
              </div>
              <div>
                <dt>Parameters</dt>
                <dd><code>{JSON.stringify(proposal.parameters)}</code></dd>
              </div>
              <div>
                <dt>Preconditions</dt>
                <dd>{proposal.preconditions.join(", ")}</dd>
              </div>
            </dl>

            {proposal.lifecycle === "PROPOSED" ? (
              <p className={styles.authorizationMessage}>
                The proposal exists, but human approval has not yet been requested.
              </p>
            ) : null}

            {proposal.lifecycle === "AWAITING_HUMAN_APPROVAL" ? (
              <div className={styles.decisionArea}>
                <p>
                  Review this exact proposal. Your decision applies only to the ID and
                  immutable content shown above.
                </p>
                <div className={styles.decisionActions}>
                  <button
                    className={styles.approveButton}
                    type="button"
                    onClick={() => operations.approvePendingChange()}
                  >
                    Approve
                  </button>
                  <button
                    className={styles.rejectButton}
                    type="button"
                    onClick={() => operations.rejectPendingChange()}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ) : null}

            {proposal.lifecycle === "APPROVED" ? (
              <p className={styles.approvedMessage}>
                Approved for authorization only. No change has executed.
              </p>
            ) : null}

            {proposal.lifecycle === "REJECTED" ? (
              <p className={styles.rejectedMessage}>
                Rejected. This proposal has no execution authority.
              </p>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
