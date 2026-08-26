"use client";

import { useEffect, useState } from "react";

import { createChangeGateOperations } from "../application/changegate-operations";
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
  const [availability, setAvailability] = useState<Availability>("CHECKING");

  useEffect(() => {
    let mounted = true;
    const modelContext = getWebMcpModelContext(document);
    const session = startWebMcpRegistration(modelContext, operations);

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
  }, [operations]);

  return (
    <p className={styles.integrationStatus} role="status" aria-live="polite">
      WebMCP: {LABELS[availability]}
    </p>
  );
}
