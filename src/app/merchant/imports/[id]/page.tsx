import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { z } from "zod";
import { TeamError } from "../../../../merchant-team/contracts";
import { teamWorkspace } from "../../../../merchant-team/runtime";
import { MerchantConsole } from "../../merchant-console";

export const dynamic = "force-dynamic";

export default async function MerchantImportPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ view?: string | string[] }>;
}) {
  const { id } = await params;
  const reviewSummary = (await searchParams).view === "summary";
  if (!z.uuid().safeParse(id).success) notFound();
  const workspace = teamWorkspace();
  const employee = workspace?.employeeFor(await headers());
  if (employee && workspace) {
    try {
      const batch = workspace.openImport(employee, id);
      if (reviewSummary && !batch.comparison) notFound();
    } catch (error) {
      if (error instanceof TeamError && error.status === 404) notFound();
      throw error;
    }
  }
  return <MerchantConsole imports importId={id} reviewSummary={reviewSummary} />;
}
