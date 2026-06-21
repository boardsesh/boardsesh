// Boardsesh — Velvet Send design-token reference.
// One tall artboard documenting the violet design language in packages/mobile:
// brand colours · the mark · V-grade scale · semantic · surfaces · typography ·
// geometry · the two render variants · what this establishes.
//
// Velvet Send is the canonical design language. Every value mirrors
// docs/ai-design-guidelines.md / packages/mobile/src/theme. The committed PNG
// (velvet-send-design-tokens-v1.png) is rendered headlessly by the sibling
// render-velvet-send-tokens.mjs (SVG → sharp); this React component is the
// editable canvas source of record, with an in-browser "Download PNG" button.
//
// Visual style: dark Velvet Send surface (#0F0B16) — the sheet is drawn in its
// own tokens. Bold sans headers, monospace for hex values. Dev-handoff feel.

(() => {
  // ---------- raw token values (source: docs/ai-design-guidelines.md) ----------
  const TOK = {
    // Brand — light + dark. tint/primary = foreground; primaryFill = filled surface.
    brand: {
      tint: {
        l: '#6D28D9',
        d: '#A78BFA',
        name: 'brand.tint / primary',
        use: 'Foreground: text, icons, links, borders',
      },
      primaryFill: { l: '#6D28D9', d: '#7C3AED', name: 'brand.primaryFill', use: 'Filled surface / button background' },
      onPrimary: { hex: '#FFFFFF', name: 'brand.onPrimary', use: 'Text + icon on primaryFill' },
      accent: { hex: '#FF8A3D', name: 'brand.accent', use: 'Amber spark — fill-only, pair with dark text' },
    },
    // Semantic — light + dark.
    semantic: {
      success: { l: '#047857', d: '#34D399', name: 'success', use: 'Logged climb, confirmation' },
      warning: { l: '#B45309', d: '#FBBF24', name: 'warning', use: 'Caution, non-blocking warnings' },
      error: { l: '#C81E1E', d: '#F87171', name: 'error', use: 'Destructive, validation errors' },
    },
    // System surfaces & labels — Android-fallback / Material-tonal hexes (iOS uses
    // PlatformColor for the same roles). Read via useTheme().systemColors.
    surfaces: {
      light: {
        background: '#F4F1FB',
        secondaryBackground: '#FFFFFF',
        elevatedSurface: '#FFFFFF',
        label: '#16111F',
        secondaryLabel: '#5B5563',
        tertiaryLabel: '#8E8898',
        separator: 'rgba(60,55,75,0.18)',
        fill: 'rgba(109,40,217,0.10)',
        accent: '#6D28D9',
      },
      dark: {
        background: '#0F0B16',
        secondaryBackground: '#181225',
        elevatedSurface: '#221A32',
        label: '#F5F2FB',
        secondaryLabel: '#A9A2B6',
        tertiaryLabel: '#6E687C',
        separator: 'rgba(180,168,205,0.20)',
        fill: 'rgba(199,184,232,0.12)',
        accent: '#A78BFA',
      },
    },
    surfaceMeta: {
      background: 'Screen base',
      secondaryBackground: 'Cards, sheets',
      elevatedSurface: 'Raised tile',
      label: 'Primary text',
      secondaryLabel: 'Secondary text',
      tertiaryLabel: 'Tertiary text',
      separator: 'Hairlines',
      fill: 'Faint violet track',
      accent: 'Links, active tab',
    },
    // Logo mark — four V-grade purples (V11–V16 family).
    mark: [
      { hex: '#9C27B0', name: 'grades.v11', role: 'top-left — brightest' },
      { hex: '#7B1FA2', name: 'grades.v12', role: 'top-right' },
      { hex: '#6A1B9A', name: 'grades.v13', role: 'bottom-left' },
      { hex: '#4A148C', name: 'grades.v15', role: 'bottom-right — deepest' },
    ],
    // Canonical V-grade ramp — packages/board-constants/src/grade-colors.ts. ★ = logo range.
    grades: [
      ['V0', '#FFD400', 'golden yellow'],
      ['V1', '#FFB300', 'amber'],
      ['V2', '#FF9100', 'orange'],
      ['V3', '#FF6D2E', 'deep orange'],
      ['V4', '#FF5026', 'red-orange'],
      ['V5', '#F03E3E', 'red'],
      ['V6', '#E22A2A', 'red'],
      ['V7', '#CF1F3C', 'crimson'],
      ['V8', '#B81A5A', 'raspberry'],
      ['V9', '#9E1A78', 'magenta'],
      ['V10', '#7E1C8E', 'grape · bridge'],
      ['V11', '#9C27B0', '★ logo'],
      ['V12', '#7B1FA2', '★ logo'],
      ['V13', '#6A1B9A', '★ logo'],
      ['V14', '#5C1A87', 'logo'],
      ['V15', '#4A148C', '★ logo'],
      ['V16', '#38006B', 'logo'],
      ['V17', '#2A0054', 'darkest'],
    ],
    // Typography — [key, HIG size/wt/lh, M3 size/wt/lh].
    type: [
      ['largeTitle', 34, 700, 41, 28, 400, 36],
      ['title1', 28, 700, 34, 24, 400, 32],
      ['title2', 22, 700, 28, 22, 400, 28],
      ['title3', 20, 600, 25, 22, 500, 28],
      ['headline', 17, 600, 22, 16, 500, 24],
      ['body', 17, 400, 22, 16, 400, 24],
      ['callout', 16, 400, 21, 16, 400, 24],
      ['subheadline', 15, 400, 20, 14, 400, 20],
      ['footnote', 13, 400, 18, 12, 400, 16],
      ['caption1', 12, 400, 16, 11, 500, 16],
      ['caption2', 11, 400, 13, 11, 500, 16],
    ],
    spacing: [
      ['0', 0],
      ['1', 4],
      ['2', 8],
      ['3', 12],
      ['4', 16],
      ['5', 20],
      ['6', 24],
      ['8', 32],
      ['10', 40],
      ['12', 48],
      ['16', 64],
    ],
    radii: [
      ['none', 0],
      ['sm', 4],
      ['md', 8],
      ['lg', 12],
      ['xl', 16],
      ['full', 9999],
    ],
    shadows: [
      ['xs', 'iOS y1 · opacity 0.05', 'elevation 1'],
      ['sm', 'iOS y1 · opacity 0.1', 'elevation 2'],
      ['md', 'iOS y4 · opacity 0.1', 'elevation 4'],
      ['lg', 'iOS y10 · opacity 0.1', 'elevation 8'],
      ['xl', 'iOS y20 · opacity 0.1', 'elevation 12'],
    ],
  };

  // Sheet theme — drawn in the dark Velvet Send surface tokens.
  const SHEET = {
    bg: '#0F0B16',
    ink: '#F5F2FB',
    muted: '#A9A2B6',
    faint: '#6E687C',
    panel: 'rgba(255,255,255,0.015)',
    border: 'rgba(180,168,205,0.14)',
    swatchBd: 'rgba(180,168,205,0.16)',
    rule: 'rgba(180,168,205,0.16)',
  };
  const FONT_DISPLAY = "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif";
  const FONT_MONO = "Menlo, 'SF Mono', 'JetBrains Mono', monospace";

  const lum = (hex) => {
    if (typeof hex !== 'string' || hex[0] !== '#' || hex.length < 7) return 0.5;
    const n = parseInt(hex.slice(1, 7), 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  };
  const onColor = (hex) => (lum(hex) > 0.6 ? 'rgba(0,0,0,0.62)' : 'rgba(255,255,255,0.85)');

  // ---------- atoms ----------
  const Mono = ({ children, c = SHEET.muted, s = 12, ls = 0.2 }) => (
    <span style={{ fontFamily: FONT_MONO, fontSize: s, color: c, letterSpacing: ls }}>{children}</span>
  );
  const Caps = ({ children, c = SHEET.faint, s = 12, mb = 0 }) => (
    <div
      style={{
        fontFamily: FONT_MONO,
        fontSize: s,
        color: c,
        letterSpacing: 2.6,
        textTransform: 'uppercase',
        marginBottom: mb,
      }}
    >
      {children}
    </div>
  );
  const H = ({ children, s = 30, mb = 8 }) => (
    <div
      style={{
        fontFamily: FONT_DISPLAY,
        fontWeight: 800,
        fontSize: s,
        color: SHEET.ink,
        letterSpacing: -0.5,
        marginBottom: mb,
      }}
    >
      {children}
    </div>
  );
  const P = ({ children, c = SHEET.muted, s = 14.5, mb = 0, max }) => (
    <div style={{ fontFamily: FONT_DISPLAY, fontSize: s, color: c, lineHeight: 1.55, marginBottom: mb, maxWidth: max }}>
      {children}
    </div>
  );
  const Rule = ({ my = 40 }) => <div style={{ height: 1, background: SHEET.rule, margin: `${my}px 0` }} />;
  const Section = ({ eyebrow, title, desc, descMax = 980, children }) => (
    <div>
      <Caps mb={14}>{eyebrow}</Caps>
      <H>{title}</H>
      <P max={descMax} mb={28}>
        {desc}
      </P>
      {children}
    </div>
  );

  // ---------- swatch primitives ----------
  function Caption({ name, hex, sub }) {
    return (
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {name && (
          <Mono c={SHEET.ink} s={13}>
            {name}
          </Mono>
        )}
        <Mono c={SHEET.muted} s={12}>
          {hex}
        </Mono>
        {sub && (
          <P c={SHEET.faint} s={12}>
            {sub}
          </P>
        )}
      </div>
    );
  }
  function Swatch({ hex, name, sub, onSwatch, h = 116 }) {
    return (
      <div>
        <div
          style={{
            background: hex,
            height: h,
            borderRadius: 12,
            border: `1px solid ${SHEET.swatchBd}`,
            display: 'flex',
            alignItems: 'flex-end',
            padding: 14,
          }}
        >
          {onSwatch && (
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: 1.4,
                textTransform: 'uppercase',
                color: onColor(hex),
              }}
            >
              {onSwatch}
            </span>
          )}
        </div>
        <Caption name={name} hex={hex.toUpperCase()} sub={sub} />
      </div>
    );
  }
  function PairSwatch({ l, d, name, sub, h = 116 }) {
    return (
      <div>
        <div
          style={{
            height: h,
            borderRadius: 12,
            border: `1px solid ${SHEET.swatchBd}`,
            overflow: 'hidden',
            display: 'flex',
          }}
        >
          {[
            ['LIGHT', l],
            ['DARK', d],
          ].map(([tag, hex]) => (
            <div key={tag} style={{ flex: 1, background: hex, display: 'flex', alignItems: 'flex-end', padding: 12 }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: 1.2, color: onColor(hex) }}>
                {tag}
              </span>
            </div>
          ))}
        </div>
        <Caption name={name} hex={`${l.toUpperCase()}  ·  ${d.toUpperCase()}`} sub={sub} />
      </div>
    );
  }

  // The four-phone mark.
  function TileMini({ size = 240, gap = 0.022 }) {
    const inner = (1 - gap) / 2;
    const cells = [
      [0, 0, '#9C27B0'],
      [inner + gap, 0, '#7B1FA2'],
      [0, inner + gap, '#6A1B9A'],
      [inner + gap, inner + gap, '#4A148C'],
    ];
    return (
      <div
        style={{
          width: size,
          height: size,
          position: 'relative',
          borderRadius: size * 0.225,
          overflow: 'hidden',
          background: '#000',
          boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
        }}
      >
        {cells.map(([x, y, c], i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${x * 100}%`,
              top: `${y * 100}%`,
              width: `${inner * 100}%`,
              height: `${inner * 100}%`,
              background: c,
            }}
          />
        ))}
      </div>
    );
  }

  // ---------- sections ----------
  const HeaderBlock = () => (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 40,
        paddingBottom: 36,
        borderBottom: '1px solid rgba(180,168,205,0.22)',
      }}
    >
      <div>
        <Caps mb={16}>Velvet Send · design tokens · v1</Caps>
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontWeight: 800,
            fontSize: 58,
            color: SHEET.ink,
            letterSpacing: -1.4,
            lineHeight: 1,
            marginBottom: 18,
          }}
        >
          Color &amp; token reference
        </div>
        <P max={1060} s={15.5}>
          The single visual reference for Velvet Send — the violet design language in{' '}
          <Mono c={SHEET.ink}>packages/mobile</Mono>, anchored on the logo's V11–V16 grade purples. One palette renders
          through two platform variants: Liquid Glass on iOS 26, Material 3 everywhere else. Values mirror{' '}
          <Mono c={SHEET.ink}>docs/ai-design-guidelines.md</Mono>.
        </P>
      </div>
      <TileMini size={200} />
    </div>
  );

  const BrandSection = () => (
    <Section
      eyebrow="01 — Brand colours"
      title="Violet identity, light + dark"
      desc={
        <>
          Read brand colours from <Mono c={SHEET.ink}>useTheme().brandColors</Mono> — the provider resolves the right
          set per scheme. Foreground (tint/primary) and filled-surface (primaryFill) differ in dark mode: the tint lifts
          to #A78BFA for legibility on near-black, while filled buttons use a brighter #7C3AED so white text still
          clears WCAG AA (5.70:1).
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 22 }}>
        <PairSwatch l={TOK.brand.tint.l} d={TOK.brand.tint.d} name={TOK.brand.tint.name} sub={TOK.brand.tint.use} />
        <PairSwatch
          l={TOK.brand.primaryFill.l}
          d={TOK.brand.primaryFill.d}
          name={TOK.brand.primaryFill.name}
          sub={TOK.brand.primaryFill.use}
        />
        <Swatch hex={TOK.brand.onPrimary.hex} name={TOK.brand.onPrimary.name} sub={TOK.brand.onPrimary.use} />
        <Swatch hex={TOK.brand.accent.hex} name={TOK.brand.accent.name} sub={TOK.brand.accent.use} onSwatch="amber" />
      </div>
    </Section>
  );

  const MarkSection = () => (
    <Section
      eyebrow="02 — The mark"
      title="Four V-grade purples from the logo"
      descMax={900}
      desc="The brand violet is drawn from the logo's upper-grade purple cluster (V11–V16) — the project-zone grades a climber works toward. The product tint #6D28D9 sits in this family. The four-quadrant mark stays readable down to favicon scale."
    >
      <div style={{ display: 'flex', gap: 44, alignItems: 'flex-start' }}>
        <TileMini size={240} />
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
          {TOK.mark.map((m, i) => (
            <Swatch key={i} hex={m.hex} name={m.name} sub={m.role} h={96} />
          ))}
        </div>
      </div>
    </Section>
  );

  const GradeSection = () => (
    <Section
      eyebrow="03 — V-grade scale"
      title="The shared climbing-grade ramp"
      desc={
        <>
          Grade colours live in <Mono c={SHEET.ink}>@boardsesh/board-constants</Mono> (V_GRADE_COLORS) and are the only
          palette shared between web and mobile. A yellow→red→purple arc that ends on the logo's V11–V16 purples (★) —
          the violet brand grows out of this top end.
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(18, 1fr)', gap: 6, marginBottom: 24 }}>
        {TOK.grades.map(([v, hex], i) => (
          <div
            key={i}
            style={{
              background: hex,
              height: 96,
              borderRadius: 5,
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'center',
              paddingBottom: 6,
            }}
          >
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: onColor(hex) }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 18 }}>
        {TOK.grades.map(([v, hex, note], i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{ width: 14, height: 14, background: hex, borderRadius: 3, border: `1px solid ${SHEET.swatchBd}` }}
            />
            <Mono c={SHEET.ink} s={12}>
              {v}
            </Mono>
            <Mono c={SHEET.muted} s={11}>
              {hex.toUpperCase()}
            </Mono>
            <Mono c={SHEET.faint} s={10}>
              {note}
            </Mono>
          </div>
        ))}
      </div>
    </Section>
  );

  const SemanticSection = () => (
    <Section
      eyebrow="04 — Semantic colours"
      title="Status tones, light + dark"
      desc="Success, warning and error brighten in dark mode so they stay legible on the near-black surface ladder. Same role keys across both schemes."
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 22 }}>
        {Object.values(TOK.semantic).map((t, i) => (
          <PairSwatch key={i} l={t.l} d={t.d} name={t.name} sub={t.use} />
        ))}
      </div>
    </Section>
  );

  const SurfaceGrid = ({ scheme }) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 22 }}>
      {Object.entries(TOK.surfaces[scheme]).map(([k, hex]) => (
        <Swatch key={k} hex={hex} name={k} sub={TOK.surfaceMeta[k]} h={78} />
      ))}
    </div>
  );
  const SurfacesSection = () => (
    <Section
      eyebrow="05 — System surfaces & labels"
      title="Backgrounds, text and chrome"
      desc={
        <>
          Resolved by platform and variant via <Mono c={SHEET.ink}>useTheme().systemColors</Mono>. iOS Liquid Glass uses
          Apple PlatformColor (adapts natively); Android and Material use these explicit, violet-tinted hexes. Same keys
          in every case.
        </>
      }
    >
      <Caps mb={18}>Light</Caps>
      <SurfaceGrid scheme="light" />
      <div style={{ height: 34 }} />
      <Caps mb={18}>Dark</Caps>
      <SurfaceGrid scheme="dark" />
    </Section>
  );

  const TypeSection = () => (
    <Section
      eyebrow="06 — Typography"
      title="Apple HIG (Liquid Glass) vs Material 3"
      desc={
        <>
          Two scales, same keys, resolved per variant via <Mono c={SHEET.ink}>theme.textStyles</Mono>. System font only
          (San Francisco / Roboto). HIG keeps bold display weights for brand identity; M3 drops them to regular. Spec:
          size / weight / line-height.
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 40 }}>
        {[
          ['Liquid Glass · HIG', 1, 2, 3],
          ['Material 3', 4, 5, 6],
        ].map(([label, si, wi, li]) => (
          <div key={label}>
            <Caps mb={18}>{label}</Caps>
            {TOK.type.map((row) => (
              <div
                key={row[0]}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: '1px solid rgba(180,168,205,0.07)',
                }}
              >
                <span
                  style={{
                    fontFamily: FONT_DISPLAY,
                    fontWeight: row[wi],
                    fontSize: Math.min(row[si], 30),
                    color: SHEET.ink,
                    letterSpacing: -0.3,
                  }}
                >
                  {row[0]}
                </span>
                <Mono c={SHEET.faint} s={12}>{`${row[si]}/${row[wi]}/${row[li]}`}</Mono>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Section>
  );

  const GeometrySection = () => (
    <Section
      eyebrow="07 — Spacing · radii · shadows"
      title="Geometry tokens"
      desc="A 4pt spacing grid, six base radii (the button corner is the one value that differs by variant — 10dp Liquid Glass, 20dp Material), and a five-step shadow ladder carrying both iOS shadow and Android elevation."
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 40 }}>
        <div>
          <Caps mb={18}>Spacing</Caps>
          {TOK.spacing.map(([k, v]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
              <div style={{ width: Math.max(v, 2), height: 14, background: TOK.brand.tint.d, borderRadius: 2 }} />
              <Mono c={SHEET.ink} s={12}>{`spacing.${k}`}</Mono>
              <Mono c={SHEET.muted} s={12}>{`${v}px`}</Mono>
            </div>
          ))}
        </div>
        <div>
          <Caps mb={18}>Radii</Caps>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 18, marginBottom: 30 }}>
            {TOK.radii.map(([k, r]) => (
              <div key={k}>
                <div
                  style={{
                    width: k === 'full' ? 120 : 96,
                    height: 96,
                    border: `2px solid ${TOK.brand.tint.d}`,
                    borderRadius: k === 'full' ? 48 : r,
                  }}
                />
                <Mono c={SHEET.muted} s={12}>
                  {k === 'full' ? 'full (pill)' : `${k} · ${r}`}
                </Mono>
              </div>
            ))}
          </div>
          <Caps mb={14}>Shadows</Caps>
          {TOK.shadows.map(([k, ios, el]) => (
            <div key={k} style={{ display: 'flex', gap: 24, marginBottom: 6 }}>
              <Mono c={SHEET.ink} s={12}>{`shadow.${k}`}</Mono>
              <Mono c={SHEET.muted} s={12}>
                {ios}
              </Mono>
              <Mono c={SHEET.faint} s={12}>{`Android ${el}`}</Mono>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );

  const VariantsSection = () => {
    const panels = [
      {
        title: 'Liquid Glass',
        sub: 'iOS 26 — Apple HIG',
        btnR: 10,
        lines: [
          'Button corner — 10dp',
          'Sheet corners — soft (glass)',
          'Tab bar — 49pt',
          'Type — Apple HIG scale',
          'Motion — reanimated springs',
        ],
      },
      {
        title: 'Material 3',
        sub: 'Android / older iOS / fallback',
        btnR: 20,
        lines: [
          'Button corner — 20dp',
          'Sheet corners — 28dp',
          'Nav bar — 80dp + indicator pill',
          'Type — Material 3 scale',
          'Feedback — ripple',
        ],
      },
    ];
    return (
      <Section
        eyebrow="08 — The two variants"
        title="Liquid Glass and Material 3"
        desc="Same palette and component APIs; the chrome follows the platform. A control is the same product in both, drawn the way that platform draws controls. Users on iOS 26 get Liquid Glass by default; everyone else gets Material 3, and either can be chosen explicitly."
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>
          {panels.map((p) => (
            <div
              key={p.title}
              style={{ border: `1px solid ${SHEET.border}`, borderRadius: 14, padding: 24, background: SHEET.panel }}
            >
              <H s={22} mb={4}>
                {p.title}
              </H>
              <Caps mb={20}>{p.sub}</Caps>
              <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
                <button
                  style={{
                    background: TOK.brand.primaryFill.d,
                    color: '#FFFFFF',
                    fontFamily: FONT_DISPLAY,
                    fontWeight: 700,
                    fontSize: 15,
                    padding: '13px 26px',
                    borderRadius: p.btnR,
                    border: 'none',
                    cursor: 'default',
                  }}
                >
                  Log ascent
                </button>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {p.lines.map((ln, j) => (
                    <Mono key={j} c={SHEET.muted} s={12.5}>
                      {ln}
                    </Mono>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>
    );
  };

  const ChangelogSection = () => {
    const rows = [
      ['CANON', 'Velvet Send', 'brand', 'Now the canonical design language — sourced from packages/mobile/src/theme.'],
      ['ADD', 'brand.tint / primary', '#6D28D9 · #A78BFA', 'Violet brand foreground. Lifts to #A78BFA in dark.'],
      [
        'ADD',
        'brand.primaryFill',
        '#6D28D9 · #7C3AED',
        'Filled-surface brand. Brighter #7C3AED in dark so white text clears AA.',
      ],
      ['ADD', 'brand.accent', '#FF8A3D', 'Warm amber spark — fill-only, always pair with dark text.'],
      [
        'VARIANT',
        'Liquid Glass / Material 3',
        '—',
        'One palette, two render variants; resolved per device, user-overridable.',
      ],
      ['LEGACY', 'web rose/sage', '#8C4A52', 'packages/web still on the old palette — pending migration, not a peer.'],
      ['SHARED', 'grade colours', '—', 'Only @boardsesh/board-constants grade colours are shared web↔mobile.'],
    ];
    const kindColor = { CANON: '#A78BFA', ADD: '#34D399', VARIANT: '#60A5FA', LEGACY: '#FBBF24', SHARED: '#A9A2B6' };
    return (
      <Section
        eyebrow="09 — What this establishes"
        title="Velvet Send vs the legacy web palette"
        desc="Velvet Send replaces the old rose/sage web palette as the design language. Web hasn't migrated yet — that palette is legacy, not a peer."
      >
        <div style={{ border: `1px solid ${SHEET.border}`, borderRadius: 10, overflow: 'hidden', marginTop: 8 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '110px 1.3fr 0.9fr 2.4fr',
              padding: '12px 18px',
              background: 'rgba(255,255,255,0.025)',
              borderBottom: `1px solid ${SHEET.rule}`,
            }}
          >
            {['KIND', 'TOKEN', 'VALUE', 'NOTE'].map((h) => (
              <Mono key={h} c={SHEET.faint} s={11}>
                {h}
              </Mono>
            ))}
          </div>
          {rows.map((r, i) => (
            <div
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: '110px 1.3fr 0.9fr 2.4fr',
                padding: '14px 18px',
                borderBottom: i < rows.length - 1 ? '1px solid rgba(180,168,205,0.06)' : 'none',
                alignItems: 'center',
              }}
            >
              <div>
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    letterSpacing: 1,
                    color: kindColor[r[0]],
                    padding: '3px 9px',
                    border: `1px solid ${kindColor[r[0]]}66`,
                    borderRadius: 999,
                    background: `${kindColor[r[0]]}1A`,
                  }}
                >
                  {r[0]}
                </span>
              </div>
              <Mono c={SHEET.ink} s={13}>
                {r[1]}
              </Mono>
              <Mono c={SHEET.muted} s={12}>
                {r[2]}
              </Mono>
              <P c={SHEET.muted} s={12.5} mb={0}>
                {r[3]}
              </P>
            </div>
          ))}
        </div>
      </Section>
    );
  };

  // ---------- root artboard ----------
  function ConceptVelvetSendTokens() {
    const ref = React.useRef(null);
    const [downloading, setDownloading] = React.useState(false);
    const downloadPng = async () => {
      if (!ref.current || !window.htmlToImage) return;
      setDownloading(true);
      try {
        const dataUrl = await window.htmlToImage.toPng(ref.current, {
          pixelRatio: 2,
          backgroundColor: SHEET.bg,
          cacheBust: true,
        });
        const link = document.createElement('a');
        link.download = 'velvet-send-design-tokens-v1.png';
        link.href = dataUrl;
        link.click();
      } catch (e) {
        console.error(e);
      }
      setDownloading(false);
    };
    return (
      <div
        ref={ref}
        style={{
          width: '100%',
          minHeight: '100%',
          background: SHEET.bg,
          padding: '56px 72px',
          boxSizing: 'border-box',
          color: SHEET.ink,
          position: 'relative',
        }}
      >
        <button
          onClick={downloadPng}
          disabled={downloading}
          style={{
            position: 'absolute',
            top: 24,
            right: 24,
            zIndex: 10,
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: 1.6,
            textTransform: 'uppercase',
            color: SHEET.ink,
            background: 'rgba(244,241,234,0.08)',
            border: '1px solid rgba(244,241,234,0.18)',
            borderRadius: 6,
            padding: '10px 16px',
            cursor: downloading ? 'wait' : 'pointer',
          }}
        >
          {downloading ? 'Rendering…' : '↓ Download PNG'}
        </button>
        <HeaderBlock />
        <div style={{ height: 56 }} />
        <BrandSection />
        <Rule />
        <MarkSection />
        <Rule />
        <GradeSection />
        <Rule />
        <SemanticSection />
        <Rule />
        <SurfacesSection />
        <Rule />
        <TypeSection />
        <Rule />
        <GeometrySection />
        <Rule />
        <VariantsSection />
        <Rule />
        <ChangelogSection />
        <div
          style={{
            marginTop: 48,
            paddingTop: 24,
            borderTop: '1px solid rgba(180,168,205,0.1)',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <Mono c={SHEET.faint} s={11}>
            Boardsesh · Velvet Send · design tokens · v1
          </Mono>
          <Mono c={SHEET.faint} s={11}>
            Source: docs/ai-design-guidelines.md · packages/mobile/src/theme
          </Mono>
        </div>
      </div>
    );
  }

  window.ConceptVelvetSendTokens = ConceptVelvetSendTokens;
})();
