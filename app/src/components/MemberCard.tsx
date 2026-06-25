import { useEffect, useRef } from "react";
import { formatMemberId } from "@/lib/ids";
import { verifyUrl } from "@/lib/verify-token";
import { Qr } from "./Qr";
import "./MemberCard.css";

export interface MemberCardProps {
  orgLogoText: string;
  memberName: string;
  memberIdCode: string;
  tierName: string;
  tierColor?: string;
  joinedAt: string;
  status?: "active" | "inactive";
  art?: string; // css background override (org theme)
  showQr?: boolean;
  interactive?: boolean;
}

/**
 * The carteirinha. Same 3D tilt/foil as the landing, reused across member-app,
 * admin preview, passport and as the passport fallback (§23.1.7).
 */
export function MemberCard({
  orgLogoText,
  memberName,
  memberIdCode,
  tierName,
  tierColor = "#b8965a",
  joinedAt,
  status = "active",
  art,
  showQr = true,
  interactive = true,
}: MemberCardProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!interactive) return;
    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    if (reduce) return;
    const stage = stageRef.current;
    const card = cardRef.current;
    if (!stage || !card) return;
    const onMove = (ev: MouseEvent) => {
      const r = stage.getBoundingClientRect();
      const px = (ev.clientX - r.left) / r.width - 0.5;
      const py = (ev.clientY - r.top) / r.height - 0.5;
      card.style.transform = `rotateY(${px * 12}deg) rotateX(${-py * 12}deg) translateY(-2px)`;
    };
    const onLeave = () => {
      card.style.transform = "rotateY(0) rotateX(0)";
    };
    stage.addEventListener("mousemove", onMove);
    stage.addEventListener("mouseleave", onLeave);
    return () => {
      stage.removeEventListener("mousemove", onMove);
      stage.removeEventListener("mouseleave", onLeave);
    };
  }, [interactive]);

  const since = new Date(joinedAt).toLocaleDateString("pt-BR", { month: "short", year: "numeric" });

  return (
    <div className="mc-stage" ref={stageRef}>
      <div
        ref={cardRef}
        className={`mc-card${status === "inactive" ? " is-inactive" : ""}`}
        style={art ? { background: art } : undefined}
      >
        <div className="mc-row mc-z1">
          <div className="mc-logo" style={{ textTransform: "lowercase" }}>
            {orgLogoText.includes("base") ? (
              <>
                {orgLogoText.replace("base", "")}
                <b>base</b>
              </>
            ) : (
              <b style={{ color: tierColor }}>{orgLogoText}</b>
            )}
          </div>
          <div className="mc-chip" />
        </div>

        <div className="mc-z2">
          <div className="mc-tierlabel" style={{ color: tierColor }}>
            membership
          </div>
          <div className="mc-tiername">{tierName}</div>
        </div>

        <div className="mc-row mc-z2" style={{ alignItems: "flex-end" }}>
          <div className="mc-holder">
            <small>membro desde {since}</small>
            {memberName}
            <div className="mc-num" style={{ color: tierColor, marginTop: 4 }}>
              {formatMemberId(memberIdCode)}
            </div>
          </div>
          {showQr && status === "active" && (
            <div className="mc-qr-inline">
              <Qr data={memberIdCode} to={verifyUrl(memberIdCode)} size={58} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
