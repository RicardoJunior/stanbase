import { useParams } from "react-router-dom";
import { getLanding } from "@/lib/api";
import { useMemberOrg } from "../useMemberOrg";
import { BlockRenderer, type BlockCtx } from "../blocks/BlockRenderer";

/** Member landing — composed from the org's page-builder blocks (§24). */
export default function Home() {
  const { orgSlug = "" } = useParams();
  const { org, db } = useMemberOrg();
  if (!org) return null;

  const blocks = getLanding(db, org);
  const ctx: BlockCtx = { org, db, orgSlug };

  return (
    <main>
      {blocks.map((block) => (
        <BlockRenderer key={block.id} block={block} ctx={ctx} />
      ))}
    </main>
  );
}
