import { CalendarDays, MapPin, Ticket as TicketIcon, ScanLine } from "lucide-react";
import { Link } from "react-router-dom";
import { useStore } from "@/lib/store";
import { listEvents, listTickets } from "@/lib/api";
import { BRL } from "@/lib/billing";
import { SectionHead, Card, CardBody, Button, Badge, Stat } from "@/components/ui";
import { useAdminOrg } from "../useAdminOrg";

export default function Events() {
  const { orgId } = useAdminOrg();
  const db = useStore((d) => d);
  if (!orgId) return null;

  const events = listEvents(db, orgId);
  const tickets = listTickets(db, orgId);
  const checkins = db.checkins.filter((c) => c.orgId === orgId);

  return (
    <div>
      <SectionHead
        eyebrow="Eventos & ingressos"
        title="Eventos"
        desc="Cada ingresso vira um passe na Wallet com QR. Check-in na portaria reaproveita a rota de validação."
        action={<Link to="/admin/validation"><Button size="sm"><ScanLine size={15} /> Abrir portaria</Button></Link>}
      />

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Stat label="Eventos" value={events.length} />
        <Stat label="Ingressos vendidos" value={tickets.length} />
        <Stat label="Check-ins" value={checkins.length} />
      </div>

      <div className="space-y-4">
        {events.map((e) => {
          const evtTickets = tickets.filter((t) => t.eventId === e.id);
          const used = evtTickets.filter((t) => t.status === "used").length;
          return (
            <Card key={e.id} className="border-t-2 border-t-gold">
              <CardBody>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="font-display text-2xl">{e.name}</h3>
                    <div className="flex flex-wrap items-center gap-4 mt-2 text-sm text-muted">
                      <span className="flex items-center gap-1.5"><CalendarDays size={15} /> {new Date(e.startsAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })}</span>
                      <span className="flex items-center gap-1.5"><MapPin size={15} /> {e.venue}</span>
                      <span className="flex items-center gap-1.5"><TicketIcon size={15} /> {BRL(e.price)}</span>
                    </div>
                  </div>
                  <Badge tone="gold">{e.capacity} lugares</Badge>
                </div>

                <div className="mt-5 grid grid-cols-3 gap-4">
                  <Mini label="Vendidos" value={`${evtTickets.length}`} />
                  <Mini label="Check-in" value={`${used}/${evtTickets.length}`} />
                  <Mini label="Ocupação" value={`${Math.round((evtTickets.length / e.capacity) * 100)}%`} />
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface-2 rounded-xl p-3 border border-line">
      <div className="font-mono text-[0.58rem] uppercase tracking-wide text-muted">{label}</div>
      <div className="font-display text-xl mt-0.5">{value}</div>
    </div>
  );
}
