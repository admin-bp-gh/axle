import { useState } from "react";
import {
  Settings, Search, Check, Pencil, RefreshCw, Archive,
  Package, User, ShoppingBag, ShieldCheck, Clock, MapPin, Inbox
} from "lucide-react";

// ── Polaris-derived design tokens ───────────────────────────────────
// This is the layer you lift into tailwind.config (theme.extend.colors /
// borderRadius / fontFamily). Everything below is styled from it.
const t = {
  bgApp: "#f1f1f1",
  surface: "#ffffff",
  surfaceSubdued: "#fafafa",
  border: "#e3e3e3",
  borderSubdued: "#ebebeb",
  text: "#303030",
  textSubdued: "#616161",
  textDisabled: "#8a8a8a",
  brand: "#303030",        // modern Shopify primary = near-black
  brandHover: "#1a1a1a",
  accent: "#008060",       // Shopify green, used sparingly
  radiusCard: 12,
  radiusCtl: 8,
  font: '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
};

const tone = {
  success:   { bg: "#e3f9ec", fg: "#0c5132", label: "Draft ready" },
  attention: { bg: "#ffeaba", fg: "#5a4200", label: "Needs info" },
  info:      { bg: "#e1eeff", fg: "#00405e", label: "Awaiting approval" },
  neutral:   { bg: "#ededed", fg: "#616161", label: "Parked" },
};

// ── Mock data ───────────────────────────────────────────────────────
const emails = [
  {
    id: 1, name: "Jan de Vries", addr: "jan.devries@kpnmail.nl", lang: "NL",
    subject: "Remblokken Discovery 4 vooras", time: "11:42", status: "success",
    loc: "Gouda", snippet: "Hebben jullie deze op voorraad en wat kost een set?",
    body:
`Goedemiddag,

Ik zoek remblokken voor de vooras van mijn Discovery 4 (2012, 3.0 TDV6).
Hebben jullie deze op voorraad en wat kost een set?

Met vriendelijke groet,
Jan de Vries`,
    context: {
      customer: "C00842 · 6 orders · laatste 12 apr 2026",
      part: "LR051626 — Brake pad set, front",
      fitment: "L319 3.0 TDV6 ✓ (SAP U_M_L319)",
      price: "€74,50 incl. btw",
      stock: [["10-GOU Gouda", 8], ["20-DRA Drachten", 3]],
    },
    draft:
`Goedemiddag Jan,

Ja, die hebben we op voorraad. Voor de vooras van uw Discovery 4 3.0 TDV6
(2012) adviseren wij set LR051626 à €74,50 incl. btw — direct leverbaar
uit Gouda.

Zal ik de set voor u klaarleggen of een betaallink sturen?

Met vriendelijke groet,
Budget Parts`,
  },
  {
    id: 2, name: "Mark Thompson", addr: "m.thompson@outlook.com", lang: "EN",
    subject: "Air suspension compressor — Range Rover L322", time: "10:18", status: "attention",
    loc: "Gouda", snippet: "Car keeps dropping overnight, think the compressor is gone.",
    body:
`Hi,

My Range Rover (L322, 2009) keeps dropping overnight and I think the
air suspension compressor has failed. Do you stock a replacement and
what's the price?

Thanks,
Mark`,
    context: {
      customer: "No SAP match — new contact",
      part: "LR023964 — Compressor (Hitachi-type)",
      fitment: "L322 facelift only — needs VIN to confirm early/late",
      price: "€312,00 incl. btw",
      stock: [["10-GOU Gouda", 2], ["20-DRA Drachten", 0]],
    },
    draft:
`Hi Mark,

The L322 used two different compressors depending on build date. To make
sure I send the right one, could you share your VIN? I'll confirm the exact
part and price straight away.

For reference the facelift unit (LR023964) is €312,00 incl. VAT and in stock
in Gouda.

Best regards,
Budget Parts`,
  },
  {
    id: 3, name: "info@ — webshop", addr: "Order #10482", lang: "NL",
    subject: "Bestelling #10482 niet ontvangen", time: "09:05", status: "info",
    loc: "Drachten", snippet: "Track & trace beweegt al 4 dagen niet.",
    body:
`Hallo,

Mijn bestelling #10482 is nog niet binnen en de track & trace beweegt al
4 dagen niet. Kunnen jullie kijken wat er aan de hand is?

Groet, R. Janssen`,
    context: {
      customer: "C01190 · order #10482 · €146,20",
      part: "Shopify: fulfilled 06 jun · PostNL 3SABCD…",
      fitment: "Tracking: stuck at sorting centre (4d)",
      price: "Status: paid",
      stock: [["Reship available", 1], ["Refund option", 1]],
    },
    draft:
`Hallo,

Vervelend dat uw pakket vaststaat. Ik zie dat de zending sinds 6 juni niet
meer is gescand bij PostNL — dat duidt op een verloren pakket.

Ik stuur vandaag kosteloos een nieuwe zending; u hoeft niets te doen. Nieuwe
track & trace volgt zodra het label is aangemaakt.

Met vriendelijke groet,
Budget Parts`,
  },
  {
    id: 4, name: "Pieter Bakker", addr: "pieter.bakker@gmail.com", lang: "NL",
    subject: "Retour aanvraag — front propshaft", time: "Yesterday", status: "neutral",
    loc: "Gouda", snippet: "Verkeerd besteld, graag retour.",
    body:
`Hoi,

Ik heb een front propshaft (TVB500160) besteld maar verkeerd gekozen.
Kan ik deze retourneren? Besteld op 2 mei.

Bedankt, Pieter`,
    context: {
      customer: "C00733 · order 02 mei 2026",
      part: "TVB500160 — Propshaft, front",
      fitment: "Return window: 30 days — order is 43 days old",
      price: "€289,00 incl. btw",
      stock: [["Outside policy", 1], ["Goodwill?", 1]],
    },
    draft:
`Parked for review — return falls outside the 30-day window (order is 43
days old). Needs a goodwill decision before a reply goes out.`,
  },
];

// ── Primitives ──────────────────────────────────────────────────────
function Badge({ status, children }) {
  const c = tone[status];
  return (
    <span style={{
      background: c.bg, color: c.fg, fontSize: 12, fontWeight: 600,
      padding: "2px 8px", borderRadius: t.radiusCtl, whiteSpace: "nowrap",
    }}>{children || c.label}</span>
  );
}

function Button({ kind = "secondary", icon: Icon, children, onClick, disabled }) {
  const base = {
    display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13,
    fontWeight: 600, padding: "8px 14px", borderRadius: t.radiusCtl,
    cursor: disabled ? "default" : "pointer", border: "1px solid transparent",
    fontFamily: t.font, transition: "background .12s",
  };
  const styles = kind === "primary"
    ? { ...base, background: t.brand, color: "#fff" }
    : { ...base, background: t.surface, color: t.text, border: `1px solid ${t.border}` };
  return (
    <button
      onClick={onClick} disabled={disabled} style={{ ...styles, opacity: disabled ? 0.5 : 1 }}
      onMouseEnter={(e) => { if (kind === "primary" && !disabled) e.currentTarget.style.background = t.brandHover; }}
      onMouseLeave={(e) => { if (kind === "primary" && !disabled) e.currentTarget.style.background = t.brand; }}
    >
      {Icon && <Icon size={15} strokeWidth={2.25} />}{children}
    </button>
  );
}

function Card({ title, icon: Icon, children, pad = 16 }) {
  return (
    <div style={{
      background: t.surface, border: `1px solid ${t.border}`,
      borderRadius: t.radiusCard, boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
    }}>
      {title && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "12px 16px",
          borderBottom: `1px solid ${t.borderSubdued}`, fontSize: 13,
          fontWeight: 600, color: t.text,
        }}>
          {Icon && <Icon size={15} color={t.textSubdued} />}{title}
        </div>
      )}
      <div style={{ padding: pad }}>{children}</div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: t.textSubdued, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, color: t.text }}>{value}</div>
    </div>
  );
}

// ── App ─────────────────────────────────────────────────────────────
export default function Axle() {
  const [selId, setSelId] = useState(1);
  const [sent, setSent] = useState({});
  const sel = emails.find((e) => e.id === selId);

  return (
    <div style={{ background: t.bgApp, minHeight: "100vh", fontFamily: t.font, color: t.text }}>
      {/* Top bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16, padding: "10px 20px",
        background: t.surface, borderBottom: `1px solid ${t.border}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 15 }}>
          <Settings size={18} color={t.accent} /> Axle
          <span style={{ fontWeight: 400, fontSize: 13, color: t.textSubdued }}>Sales copilot</span>
        </div>
        <div style={{ display: "flex", gap: 6, marginLeft: 8 }}>
          {["info@budget-parts.nl", "drachten@budget-parts.nl"].map((m, i) => (
            <span key={m} style={{
              fontSize: 12, fontWeight: 600, padding: "5px 10px", borderRadius: t.radiusCtl,
              background: i === 0 ? t.bgApp : "transparent",
              color: i === 0 ? t.text : t.textSubdued, cursor: "pointer",
            }}>{m}</span>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          <Search size={16} color={t.textSubdued} />
          <Badge status="info">4 to review</Badge>
        </div>
      </div>

      <div style={{ display: "flex", height: "calc(100vh - 53px)" }}>
        {/* Left pane — inbox list */}
        <div style={{
          width: 360, background: t.surface, borderRight: `1px solid ${t.border}`,
          overflowY: "auto", flexShrink: 0,
        }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 8, padding: "12px 16px",
            fontSize: 13, fontWeight: 600, borderBottom: `1px solid ${t.borderSubdued}`,
          }}>
            <Inbox size={15} color={t.textSubdued} /> Inbox
            <span style={{ color: t.textSubdued, fontWeight: 400 }}>· {emails.length}</span>
          </div>
          {emails.map((e) => {
            const active = e.id === selId;
            return (
              <div key={e.id} onClick={() => setSelId(e.id)} style={{
                padding: "12px 16px", cursor: "pointer",
                borderBottom: `1px solid ${t.borderSubdued}`,
                borderLeft: active ? `3px solid ${t.brand}` : "3px solid transparent",
                background: active ? t.surfaceSubdued : t.surface,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: "50%", background: t.bgApp,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 700, color: t.textSubdued, flexShrink: 0,
                  }}>{e.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</div>
                  <span style={{ fontSize: 13, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                  <span style={{ fontSize: 11, color: t.textDisabled }}>{e.time}</span>
                </div>
                <div style={{ fontSize: 13, marginTop: 4, marginLeft: 36, fontWeight: 500 }}>{e.subject}</div>
                <div style={{ fontSize: 12, color: t.textSubdued, marginTop: 2, marginLeft: 36, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.snippet}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 8, marginLeft: 36 }}>
                  <Badge status={e.status} />
                  <span style={{ fontSize: 11, color: t.textSubdued, display: "inline-flex", alignItems: "center", gap: 3 }}>
                    <MapPin size={11} /> {e.loc} · {e.lang}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Right pane — detail */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Header */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{sel.subject}</h1>
                <Badge status={sel.status} />
              </div>
              <div style={{ fontSize: 13, color: t.textSubdued, marginTop: 4 }}>
                {sel.name} · {sel.addr}
              </div>
            </div>

            {/* Original message */}
            <Card title="Customer message" icon={User}>
              <pre style={{ margin: 0, fontFamily: t.font, fontSize: 13, lineHeight: "20px", whiteSpace: "pre-wrap" }}>{sel.body}</pre>
            </Card>

            {/* Context */}
            <Card title="Grounded in SAP + Shopify" icon={ShoppingBag}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <Field label="Customer" value={sel.context.customer} />
                <Field label="Identified part" value={sel.context.part} />
                <Field label="Fitment / status" value={sel.context.fitment} />
                <Field label="Price" value={sel.context.price} />
              </div>
              <div style={{ marginTop: 14, border: `1px solid ${t.borderSubdued}`, borderRadius: t.radiusCtl, overflow: "hidden" }}>
                {sel.context.stock.map(([loc, qty], i) => (
                  <div key={loc} style={{
                    display: "flex", justifyContent: "space-between", padding: "8px 12px",
                    fontSize: 13, background: i % 2 ? t.surfaceSubdued : t.surface,
                  }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: t.textSubdued }}>
                      <Package size={14} /> {loc}
                    </span>
                    <span style={{ fontWeight: 600 }}>{qty}</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* Draft */}
            <Card title="Drafted reply" icon={ShieldCheck} pad={0}>
              <div style={{ padding: 16 }}>
                <pre style={{ margin: 0, fontFamily: t.font, fontSize: 13, lineHeight: "20px", whiteSpace: "pre-wrap" }}>{sel.draft}</pre>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, fontSize: 12, color: t.textSubdued }}>
                  <Clock size={12} /> Drafted by Axle · {sel.lang} · awaiting your approval
                </div>
              </div>
              <div style={{
                display: "flex", gap: 8, padding: "12px 16px", borderTop: `1px solid ${t.borderSubdued}`,
                background: t.surfaceSubdued, borderBottomLeftRadius: t.radiusCard, borderBottomRightRadius: t.radiusCard,
              }}>
                <Button kind="primary" icon={Check} disabled={sent[sel.id]} onClick={() => setSent((s) => ({ ...s, [sel.id]: true }))}>
                  {sent[sel.id] ? "Sent" : "Approve & send"}
                </Button>
                <Button icon={Pencil}>Edit draft</Button>
                <Button icon={RefreshCw}>Regenerate</Button>
                <Button icon={Archive}>Park</Button>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
