import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import "./landing.css";

/**
 * Faithful React port of stanbase.html — the brand source of truth.
 * Same markup, same styles (landing.css), same interactions (nav blur on scroll,
 * reveal-on-scroll, 3D member-card tilt). CTAs route into the live prototype.
 */
export default function Landing() {
  const navRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const nav = navRef.current;
    const onScroll = () => nav?.classList.toggle("scrolled", window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.14 }
    );
    document.querySelectorAll(".sb-landing .reveal").forEach((el) => io.observe(el));

    let onMove: ((ev: MouseEvent) => void) | undefined;
    let onLeave: (() => void) | undefined;
    const stage = stageRef.current;
    const card = cardRef.current;
    if (!reduce && stage && card) {
      onMove = (ev) => {
        const r = stage.getBoundingClientRect();
        const px = (ev.clientX - r.left) / r.width - 0.5;
        const py = (ev.clientY - r.top) / r.height - 0.5;
        card.style.transform = `rotateY(${px * 12}deg) rotateX(${-py * 12}deg) translateY(-2px)`;
      };
      onLeave = () => {
        card.style.transform = "rotateY(0) rotateX(0)";
      };
      stage.addEventListener("mousemove", onMove);
      stage.addEventListener("mouseleave", onLeave);
    }

    return () => {
      window.removeEventListener("scroll", onScroll);
      io.disconnect();
      if (stage && onMove) stage.removeEventListener("mousemove", onMove);
      if (stage && onLeave) stage.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <div className="sb-landing">
      <nav ref={navRef} id="nav">
        <div className="wrap nav-in">
          <div className="logo">
            stan<b>base</b>
          </div>
          <div className="nav-links">
            <a href="#integracoes">Integrações</a>
            <a href="#plataforma">Plataforma</a>
            <a href="#ia">IA</a>
            <a href="#preco">Preço</a>
          </div>
          <Link className="btn btn-gold" to="/onboarding">
            Criar minha base
          </Link>
        </div>
      </nav>

      <header className="hero">
        <div className="wrap hero-grid">
          <div className="reveal">
            <span className="eyebrow">Membership · IA-first</span>
            <h1>
              Trate cada fã
              <br />
              como ele <span className="em">merece</span>.
            </h1>
            <p className="lead">
              stanbase transforma a sua comunidade em uma base de membros — clubes, times, comunidades e
              creators, com proximidade real, receita recorrente e uma IA que conhece cada fã pelo nome.
            </p>
            <div className="hero-cta">
              <Link className="btn btn-gold" to="/onboarding">
                Criar minha base
              </Link>
              <Link className="btn btn-ghost" to="/m/aurora">
                Ver demo de membro
              </Link>
            </div>
            <p className="hero-note">
              conecta em minutos · <span>sem código</span> · feito no Brasil
            </p>
          </div>
          <div className="reveal card-stage" ref={stageRef}>
            <div className="member-card" ref={cardRef}>
              <div className="mc-top">
                <div className="mc-logo">
                  stan<b>base</b>
                </div>
                <div className="mc-chip"></div>
              </div>
              <div className="mc-tier">
                <div className="label">membership</div>
                <div className="name">Founding Member</div>
              </div>
              <div className="mc-bottom">
                <div className="holder">
                  <small>membro</small>seu maior fã
                </div>
                <div className="num">Nº 001</div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="trust">
        <div className="wrap trust-in">
          <p>Uma base para qualquer comunidade de fãs</p>
          <div className="trust-logos">
            <span>clubes de carro</span>
            <span>times &amp; torcidas</span>
            <span>gamers</span>
            <span>baladas</span>
            <span>creators</span>
          </div>
        </div>
      </div>

      <section className="block" id="integracoes">
        <div className="wrap">
          <div className="sec-head reveal">
            <span className="eyebrow">Integrações</span>
            <h2>
              Conecta tudo.
              <br />
              Sem pagar a mais.
            </h2>
            <p>
              Toda integração é grátis — todas elas, em qualquer plano, pra sempre. Plugue o que a sua
              comunidade já usa em minutos, sem custo extra e sem código.
            </p>
          </div>
          <div className="int-grid">
            {INTEGRATIONS.map((it) => (
              <div className="int-card reveal" key={it.title}>
                <div className="int-tag">
                  <span className="int-dot"></span>
                  {it.tag}
                </div>
                <h3>{it.title}</h3>
                <p>{it.desc}</p>
                <div className="int-names">
                  {it.names.map((n) => (
                    <em key={n}>{n}</em>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="int-foot reveal">não vê a sua ferramenta? a gente conecta pra você.</p>
        </div>
      </section>

      <section className="block" id="recursos" style={{ paddingTop: 20 }}>
        <div className="wrap">
          <div className="sec-head reveal">
            <span className="eyebrow">Recursos</span>
            <h2>
              Feito para tratar
              <br />
              fã como fã merece.
            </h2>
            <p>
              Os detalhes que transformam seguidor em membro — e membro em alguém que nunca quer sair.
            </p>
          </div>
          <div className="feat-grid">
            <div className="feat-card reveal">
              <span className="feat-label">qualificação · IA</span>
              <h3>Qualifique no automático</h3>
              <p>
                A IA gera as perguntas certas e descobre quem é cada fã — interesses, perfil e potencial —
                sem você levantar um dedo.
              </p>
            </div>
            <div className="feat-card reveal">
              <span className="feat-label">reconhecimento</span>
              <h3>Hall of fame</h3>
              <p>
                Aos melhores, o destaque que merecem. Rankings, conquistas e um lugar de honra para quem
                mais ama a sua marca.
              </p>
            </div>
            <div className="feat-card reveal">
              <span className="feat-label">comunicação</span>
              <h3>Perto de quem te ama</h3>
              <p>
                Envie mensagens, recados e presentes para os membros certos. Proximidade real, na hora
                certa, com a sua voz.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="block" id="plataforma" style={{ paddingTop: 20 }}>
        <div className="wrap">
          <div className="sec-head reveal">
            <span className="eyebrow muted">A plataforma</span>
            <h2>
              Leve para você.
              <br />
              Premium para o fã.
            </h2>
          </div>
          <div className="pillars">
            <div className="pillar reveal">
              <span className="n">01 — proximidade</span>
              <h3>Esteja perto de quem te ama</h3>
              <p>
                Canais, perks e momentos exclusivos que aproximam você dos fãs que mais importam — sem
                ruído, sem distância.
              </p>
            </div>
            <div className="pillar reveal">
              <span className="n">02 — receita</span>
              <h3>Receita recorrente, sem fricção</h3>
              <p>
                Assinatura e tiers que viram receita previsível para a sua comunidade, montados em um dia.
              </p>
            </div>
            <div className="pillar reveal">
              <span className="n">03 — alinhamento</span>
              <h3>Tudo em um só lugar</h3>
              <p>
                Comunidade, conteúdo, eventos e membros sob a sua marca — uma base única, alinhada com o
                seu mundo.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="block ai" id="ia">
        <div className="glow"></div>
        <div className="wrap ai-grid">
          <div className="reveal">
            <span className="eyebrow">IA-first</span>
            <h2>Uma IA que conhece cada fã pelo nome.</h2>
            <p className="lead">
              stanbase não é mais um painel pra você gerenciar. É uma camada de inteligência que cuida da
              sua base enquanto você cria.
            </p>
            <div className="hero-cta" style={{ marginTop: 30 }}>
              <Link
                className="btn btn-gold"
                to="/admin/ai"
                style={{ background: "var(--gold)", color: "var(--obsidian)" }}
              >
                Ver a IA em ação
              </Link>
            </div>
          </div>
          <div className="ai-feats reveal">
            {AI_FEATS.map((f) => (
              <div className="ai-feat" key={f.k}>
                <div className="k">{f.k}</div>
                <div>
                  <div className="t">{f.t}</div>
                  <div className="d">{f.d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="block" id="tiers">
        <div className="wrap">
          <div className="sec-head reveal">
            <span className="eyebrow">Os membros</span>
            <h2>Tiers totalmente seus.</h2>
            <p>
              Nomes, preços, perks e ordem — tudo configurável, arrastando e soltando. A mesma engine veste
              qualquer comunidade. Veja como ela se adapta:
            </p>
          </div>
          <div className="verticals">
            {VERTICALS.map((v) => (
              <div className="vert reveal" key={v.label}>
                <div className="vlabel">
                  <span className="int-dot"></span>
                  {v.label}
                </div>
                <ul>
                  {v.tiers.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="vert-note">mesma engine · infinitas configurações · do seu jeito</p>
        </div>
      </section>

      <section className="block price" id="preco">
        <div className="glow"></div>
        <div className="wrap price-in">
          <div className="reveal">
            <span className="eyebrow">Preço</span>
            <h2>Simples assim.</h2>
            <p className="lead">
              Uma taxa fixa por transação. Sem mensalidade, sem setup, sem letrinha miúda. Você só paga
              quando recebe.
            </p>
          </div>
          <div className="price-card reveal">
            <div className="price-num">
              7,99<span>%</span>
            </div>
            <div className="price-sub">por transação</div>
            <ul className="price-list">
              <li>
                <b>—</b>Plataforma completa inclusa: comunidade, conteúdo, eventos e membros
              </li>
              <li>
                <b>—</b>Todas as integrações, sem custo extra
              </li>
              <li>
                <b>—</b>IA-first inclusa em todos os planos
              </li>
              <li>
                <b>—</b>Tiers e perks ilimitados
              </li>
            </ul>
            <p className="price-fine">É só isso. Sem mensalidade, sem surpresa.</p>
          </div>
        </div>
      </section>

      <section className="cta-final" id="demo">
        <div className="wrap reveal">
          <span className="eyebrow">Pronto quando você estiver</span>
          <h2>Eleve a sua comunidade.</h2>
          <p>
            Mostramos em 20 minutos como a sua base de fãs vira uma base de membros — com a sua marca, no
            seu mundo.
          </p>
          <Link className="btn btn-gold" to="/onboarding" style={{ padding: "15px 34px", fontSize: "1rem" }}>
            Criar minha base agora
          </Link>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <div className="foot-in">
            <div className="foot-brand">
              <div className="logo">
                stan<b>base</b>
              </div>
              <p>
                A base de membros das maiores comunidades. Proximidade, receita e IA — sob a sua marca.
              </p>
            </div>
            <div className="foot-col">
              <h4>Plataforma</h4>
              <a href="#integracoes">Integrações</a>
              <a href="#ia">IA-first</a>
              <a href="#tiers">Tiers de membro</a>
              <a href="#preco">Preço</a>
            </div>
            <div className="foot-col">
              <h4>Para quem</h4>
              <a href="#">Clubes &amp; associações</a>
              <a href="#">Times &amp; torcidas</a>
              <a href="#">Gamers &amp; esports</a>
              <a href="#">Creators &amp; baladas</a>
            </div>
            <div className="foot-col">
              <h4>Demo</h4>
              <Link to="/onboarding">Criar minha base</Link>
              <Link to="/admin">Admin do dono</Link>
              <Link to="/m/aurora">Área de membro</Link>
              <Link to="/superadmin">Stanbase staff</Link>
            </div>
          </div>
          <div className="foot-base">
            <span>© 2026 stanbase</span>
            <span>feito no Brasil · trate cada fã como ele merece</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

const INTEGRATIONS = [
  {
    tag: "conteúdo",
    title: "Conteúdo só de membro",
    desc: "VODs exclusivas, lives fechadas e bastidores liberados conforme o tier do membro.",
    names: ["Twitch", "YouTube", "Vimeo"],
  },
  {
    tag: "eventos",
    title: "Ingressos e ativações",
    desc: "Acesso antecipado, lote de membro e drops de evento direto na área de membros.",
    names: ["Ingresse", "Sympla", "Loja oficial"],
  },
  {
    tag: "identidade",
    title: "Entra com um clique",
    desc: "Login social e verificação de quem é fã de verdade, sem formulário chato.",
    names: ["Google", "Apple", "X"],
  },
  {
    tag: "perks do seu nicho",
    title: "Benefícios sob medida",
    desc: "Gamer conecta a conta do jogo, torcedor valida o sócio, clube de carro reconhece o modelo.",
    names: ["Steam", "Riot", "APIs do nicho"],
  },
  {
    tag: "canais & comunidade",
    title: "Cada tier, seus canais",
    desc: "Cargos e grupos liberados na hora certa, em todas as ferramentas onde a sua galera conversa.",
    names: ["Discord", "Telegram", "WhatsApp"],
  },
  {
    tag: "automação & api",
    title: "Liga no seu stack",
    desc: "API aberta, webhooks e automações prontas pra conectar com o resto das suas ferramentas.",
    names: ["API", "Webhooks", "Zapier"],
  },
];

const AI_FEATS = [
  {
    k: "01",
    t: "Segmenta sozinha",
    d: "Reconhece o superfã, o recém-chegado e quem está prestes a sair — e age em cada um.",
  },
  {
    k: "02",
    t: "Sugere o próximo perk",
    d: "Propõe o benefício certo, na hora certa, pra cada tier converter mais.",
  },
  {
    k: "03",
    t: "Escreve por você",
    d: "Mensagens, drops e campanhas na voz da sua marca, prontas para revisar e enviar.",
  },
  { k: "04", t: "Prevê o churn", d: "Avisa antes do fã cancelar e sugere como trazê-lo de volta." },
];

const VERTICALS = [
  { label: "clube de carro", tiers: ["Visitante", "Associado", "Piloto", "Fundador"] },
  { label: "time de futebol", tiers: ["Torcedor", "Sócio", "Sócio Ouro", "Camarote"] },
  { label: "comunidade gamer", tiers: ["Fã", "Membro", "VIP", "Founder"] },
  { label: "balada / clube", tiers: ["Lista", "Frequentador", "VIP", "Black"] },
];
