import { Badge } from "@/components/ui";
import type { Member, MemberMetrics, Period } from "@/types/domain";

export function statusBadge(member: Member, _metrics?: MemberMetrics) {
  switch (member.status) {
    case "active":
      return <Badge tone="success">ativo</Badge>;
    case "reactivated":
      return <Badge tone="success">reativado</Badge>;
    case "past_due":
      return <Badge tone="warning">grace</Badge>;
    case "canceled":
      return <Badge tone="danger">cancelado</Badge>;
    case "lead":
      return <Badge tone="neutral">lead</Badge>;
    default:
      return <Badge>{member.status}</Badge>;
  }
}

export const periodLabel: Record<Period, string> = {
  monthly: "mensal",
  quarterly: "trimestral",
  semiannual: "semestral",
  annual: "anual",
  one_time: "único",
  lifetime: "vitalício",
};

export const methodLabel: Record<string, string> = {
  pix: "Pix",
  credit_card: "Cartão",
  boleto: "Boleto",
};
