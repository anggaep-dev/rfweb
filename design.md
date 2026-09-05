# Aether Mech HUD — Design System (DESIGN.md)

> Comprehensive UI design system extracted from classic sci-fi/fantasy MMORPG interface patterns (Novus / Bellato Corps aesthetic), calibrated for high-density HUDs, tactical equipment management, and persistent game clients.

---

## 1. Visual Identity & Brand Philosophy

- **Aesthetic Core**: High-density military cyber-fantasy / industrial mech cockpit. Low-luminance tactical matte surfaces punctured by radioactive status indicators and holy golden energy conduits.
- **Form Follows Function**: Micro-beveled panels, recessed slot matrices, and tabular monospace readouts engineered for instant legibility in high-stakes combat scenarios.
- **Atmosphere**: Dark slate steel, matte carbon composite frames, deep neon cyan telemetry, and ceremonial warm amber accents.

---

## 2. Color Palette & Tokens

### Surface & Containers (Tactical Dark Mode)
| Token | Hex | Role / Application |
|---|---|---|
| `surface-base` | `#0a0e15` | Void backdrop, canvas viewport, deep recessed slot wells |
| `surface-panel` | `#10131b` | Primary modal/window fill, HUD background substrate |
| `surface-panel-alt` | `#181c23` | Secondary container fill, equipment matrix backing |
| `surface-elevated` | `#202737` | Active tab headers, floating tooltips, elevated buttons |
| `surface-highlight`| `#353941` | High-contrast bevel edges, top-edge panel highlights |

### Borders & Structural Chrome
| Token | Hex | Role / Application |
|---|---|---|
| `border-subtle` | `#1f2533` | Grid slot boundaries, inactive dividers |
| `border-chrome` | `#2d3446` | Panel perimeter borders, window frames |
| `border-bevel-light` | `rgba(255, 255, 255, 0.08)` | 1px top/left inset inner light reflection |
| `border-bevel-dark` | `rgba(0, 0, 0, 0.90)` | 1px bottom/right recessed shadow |

### Status, Vitals & Energy Accents
| Token | Hex | Role / Application |
|---|---|---|
| `accent-primary` / `gold-amber` | `#d4a246` | Primary action CTAs, active weapon glow, Gold currency, high-tier rarity |
| `accent-gold-hover` | `#e8b75c` | CTA hover state, active enhancement borders |
| `energy-cyan` | `#22d3ee` | Telemetry link, active bag indicator, online status pips, Mana/SP cells |
| `vital-ruby` | `#f43f5e` | Health (HP) vital pods, lethal warning indicators, hostiles |
| `vital-emerald` | `#34d179` | Stamina, rare mineral jewels, positive reinforcement pips |
| `aether-violet` | `#9c62ea` | Archon auras, ethereal wing FX, holy ceremonial enchantments |

### Text & Readability
| Token | Hex | Role / Application |
|---|---|---|
| `text-primary` | `#f1f5f9` | Window headers, primary values, active callsigns |
| `text-secondary` | `#94a3b8` | Slot labels, inactive tab labels, metadata |
| `text-muted` | `#64748b` | Empty slot silhouettes, footer breadcrumbs, passive telemetry |
| `text-gold` | `#fbbf24` | Item enhancement tiers (`+5`, `+4`), gold balance |
| `text-cyan` | `#38bdf8` | CP currency, level badges, online status |

---

## 3. Typography Hierarchy

### Font Families
- **Display & Headings**: `Space Grotesk`, sans-serif (Weights: 500, 700) — clean, technical, high legibility.
- **Tactical Data & Numbers**: `Share Tech Mono` or `JetBrains Mono`, monospace (Weights: 400, 700) — fixed-width tabular data for combat logs, cooldown timers, currency, and stack counts.

### Type Scale
| Level | Font Family | Size | Weight | Tracking / Case | Usage |
|---|---|---|---|---|---|
| **Display / Title** | Space Grotesk | 24px–32px | 700 | Tracking-wide, Upper | Faction Title, Main Banner |
| **Window Header** | Space Grotesk | 12px–14px | 700 | Tracking-wider, Upper | Modal/HUD Title Bar ("INVENTORY") |
| **Section Header** | Space Grotesk | 12px | 600 | Normal | Sub-container ("Bag 3") |
| **Data / Numbers** | Monospace | 13px–15px | 700 | Tracking-tight | Currencies, Stack counters |
| **Badges / Tiers** | Monospace | 10px–11px | 700 | None | Enhancement level (`+5`), Capacity (`4/20`) |
| **Micro Labels** | Space Grotesk | 10px | 600 | Tracking-widest, Upper | Badges (`CP`, `GOLD`, `LIVE`) |

---

## 4. Spacing & Elevation System

### Spacing Scale
- `space-1`: `4px` — Micro gap between grid slots, badge paddings
- `space-2`: `8px` — Inner panel padding, sub-element separation
- `space-3`: `12px` — Section margins, header horizontal padding
- `space-4`: `16px` — Modal interior margins, primary container padding
- `space-6`: `24px` — Screen edge gutters, major structural splits

### Panel Elevation & Shadows
- **Level 0 (Recessed Slot)**: `background: radial-gradient(circle, #0f1218 0%, #080a0e 100%); box-shadow: inset 1px 1px 3px rgba(0,0,0,0.9); border: 1px solid #1f2533;`
- **Level 1 (Window Substrate)**: `background: linear-gradient(180deg, #181c26 0%, #10131b 100%); box-shadow: 0 8px 24px rgba(0,0,0,0.8), inset 1px 1px 0 rgba(255,255,255,0.08); border: 1px solid #2d3446;`
- **Level 2 (Active Element / Glowing Aura)**: `border-color: #d4a246; box-shadow: 0 0 10px rgba(212, 162, 70, 0.4), inset 0 0 4px rgba(212, 162, 70, 0.2);`

---

## 5. Core Component Specifications

### 5.1 HUD Window Frame
- **Header Strip**: `h-8`, flex items-center justify-between, `bg-[#1b212d]`, bottom border `1px solid #2a3244`.
- **Status Indicator**: Left-aligned 8px circular glowing LED pip (`bg-cyan-400`, `shadow-[0_0_8px_rgba(34,211,238,0.8)]`).
- **Window Controls**: Right-aligned minimalist close icon button (`hover:text-white transition-colors`).

### 5.2 Equipment Matrix (Paperdoll)
- **Grid Layout**: 5-column symmetrical matrix representing humanoid equipment sockets (Headgear, Torso, Greaves, Boots, Main-hand, Off-hand, Cape, Rings, Amulets).
- **Slot Dimensions**: `w-12 h-12` (48×48px) or `w-14 h-14` (56×56px) rounded (`2px` border radius).
- **Socket States**:
  - *Empty*: Subtle wireframe silhouette of the gear type rendered at 25% opacity slate (`#475569`).
  - *Equipped*: High-contrast item icon centered with crisp drop shadow.
  - *Enhancement Badge*: Bottom-right corner aligned monospace tag (`+3` cyan, `+5` amber).

### 5.3 Inventory Bag Matrix
- **Bag Tabs**: 5 horizontal pocket selector tabs. Active tab features a 2px top cyan highlight bar (`#22d3ee`) and elevated dark slate background.
- **Slot Capacity**: 4×5 or 4×6 grid matrix.
- **Stack Counter**: Monospace font (`text-[10px]`), right-aligned at `bottom-1 right-1` with text drop shadow for legibility over item sprites.
- **Footer Strip**: Real-time capacity tracker (`Capacity: 4 / 20`) with divider rule.

### 5.4 Primary CTA Button
- **Default Fill**: Linear gradient `from-[#e69c24] to-[#c97f10]`
- **Text**: Bold sans-serif uppercase with subtle drop-shadow (`text-[#0a0e15] font-bold`)
- **Border**: `1px solid #f59e0b`
- **Glow Effect**: `box-shadow: 0 0 14px rgba(212, 162, 70, 0.5)`
- **Hover/Active**: Brighter saturation, inward micro-compression (`active:scale-[0.98]`).
