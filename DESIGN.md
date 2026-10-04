---
name: Emit
description: Bilingual agenda-inspired team workspace for sustained reading, messaging, and mail.
colors:
  workspace-light: "#f5f3f8"
  workspace-dark: "#17131d"
  reading-surface-light: "#ffffff"
  reading-surface-dark: "#1f1b25"
  raised-surface-light: "#f0ecf4"
  raised-surface-dark: "#2a2432"
  divider-light: "#e7e1eb"
  divider-dark: "#3a3043"
  strong-divider-light: "#c9bdcf"
  strong-divider-dark: "#675574"
  ink-light: "#28212f"
  ink-dark: "#eee8f4"
  secondary-ink-light: "#6d6475"
  secondary-ink-dark: "#b5aabb"
  accent-light: "#6f4596"
  accent-dark: "#c5a0e8"
  on-accent-light: "#ffffff"
  on-accent-dark: "#281535"
  accent-wash-light: "#f0e7f8"
  accent-wash-dark: "#35283f"
  selected-surface-light: "#ede3f7"
  selected-surface-dark: "#463354"
  selected-ink-light: "#542c78"
  selected-ink-dark: "#f2e7fc"
  rail-light: "#33253e"
  rail-dark: "#21182b"
  rail-ink: "#f6f0fb"
  rail-muted: "#c5b8d0"
typography:
  ui:
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    lineHeight: 1.5
  metadata:
    fontSize: "13px"
    lineHeight: 1.5
  prose:
    fontSize: "16px"
    lineHeight: 1.7
  page-title:
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
  mail-title:
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.35
  onboarding-title:
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1.3
rounded:
  control: "8px"
  container: "12px"
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-6: "24px"
  space-8: "32px"
components:
  button-primary:
    backgroundColor: "var(--accent)"
    textColor: "var(--accent-text)"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "40px"
  button-secondary:
    backgroundColor: "var(--bg-raise)"
    textColor: "var(--text)"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "40px"
  button-danger:
    backgroundColor: "var(--error-bg)"
    textColor: "var(--error)"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "40px"
  input-field:
    backgroundColor: "var(--bg-soft)"
    textColor: "var(--text)"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "40px"
  nav-item-active:
    backgroundColor: "var(--rail-selected)"
    textColor: "var(--rail-text)"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "40px"
  chip-info:
    backgroundColor: "var(--accent-soft)"
    textColor: "var(--accent)"
    typography: "{typography.metadata}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "24px"
  employee-card:
    backgroundColor: "transparent"
    textColor: "var(--text)"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "16px"
  identity-avatar:
    backgroundColor: "generated mosaic palette"
    textColor: "generated mosaic palette"
    rounded: "{rounded.control}"
    width: "32px"
    height: "32px"
  chat-composer:
    backgroundColor: "var(--bg-soft)"
    rounded: "{rounded.container}"
    width: "min(100%, 840px)"
---

# Design System: Emit

## Overview

**Creative North Star: "双语议程式团队工作台"**

Emit's workspace borrows the clear hierarchy and compact metadata of a bilingual conference agenda, while remaining a conventional web work surface. A deep aubergine rail frames clean, theme-aware reading surfaces. Chat and mail carry equal visual weight: one supports synchronous conversation, the other asynchronous delivery, and both keep authorship, role, address, and time close to the content.

The interface favors native controls, quiet borders, concise navigation, and a measured reading column over decorative panels. The signature identity marginalia joins initials and a fine accent rule to the author line; it is an attribution device, not a generic card ornament. Light and dark themes use the same semantic roles, and the system font stack serves both English and Simplified Chinese without a remote font dependency.

**Key Characteristics:**
- Aubergine navigation against low-noise reading surfaces.
- Chat and mail share the same identity and content hierarchy.
- Compact controls and metadata support long, sustained reading.
- Keyboard focus and narrow-screen workflows remain visible and reachable.

## Colors

The palette is a paired light/dark set of pale neutral surfaces, legible ink, a restrained purple accent, and a persistent aubergine rail; status colors remain semantic rather than decorative.

### Primary
- **Aubergine Accent:** The theme-selected accent marks primary actions, focused controls, and small signature details.
- **Rail Aubergine:** A stable navigation field groups workspace destinations; high-contrast rail text and its muted secondary tone are shared across themes.

### Neutral
- **Workspace and Reading Surfaces:** A subtly tinted workspace canvas sits behind the clean primary reading surface; raised surfaces and dividers separate controls without turning each item into a card.
- **Primary and Secondary Ink:** Main copy stays distinct from metadata, hints, and timestamps in both themes.
- **Selection:** Selected navigation and list items use a separate surface/ink pair rather than relying on accent hue alone.

### Named Rules
**The Paired Theme Rule.** Use the existing semantic light/dark token pairs so every component follows the active theme; do not pin a new surface to one palette.

**The Status-Has-Meaning Rule.** Keep success, warning, and error hues attached to real state. The status roles and surfaces already present in the stylesheet are semantic palette tokens; sidecar tonal ramps are synthesized swatch metadata, not shipped application tokens.

## Typography

The system UI stack is the single interface voice for both supported locales. Monospace remains confined to code and technical values; natural-language conversation and mail use the prose role.

### Hierarchy
- **UI:** The compact default for controls, navigation, labels, and ordinary interface copy.
- **Metadata:** Author roles, addresses, timestamps, hints, and secondary details.
- **Prose:** Readable message and mail bodies, with generous line spacing and bounded measures.
- **Page title:** The pane heading, separate from the interface's larger onboarding heading.
- **Mail title:** A strong but restrained subject line that may wrap to two lines.
- **Onboarding title:** The larger first-run heading; this is not a general display face.

## Layout

The desktop workspace uses a fixed 248px rail beside a flexible main pane. The rail header is 72px; room lists scroll within their own sections so the mailbox entry and footer remain reachable. Pane headers use the same 72px desktop baseline, with a narrower wrapped arrangement on small screens. At the 760px viewport breakpoint, the rail becomes a drawer and the workspace keeps one main column; coarse-pointer controls receive a minimum 44px target. Standard buttons and fields are 40px high, while icon-only controls are 36px in the fine-pointer layout.

Chat keeps an 840px centered conversation frame and a 736px message-text measure. The shared identity row aligns author, role/address, and time before the 16px/1.7 body copy; the composer shares the conversation frame. Mail starts with a 144px folder rail. At a 1040px mail-container width, an open reader sits beside a 320px thread list; at 680px or narrower, folders collapse into the existing native folder select and reader/list layouts remain single-column. In browsers without container-query support, the corresponding viewport fallbacks are 1288px for the split reader and 928px for the compact folder-select layout. Mail's message text is bounded independently from the wider article column. Employee editing stacks below 900px.

Use the 4/8/12/16/24/32px spacing rhythm for repeated gaps and padding. Let the app pane own scrolling; only content regions that need it should scroll locally, and long prose must wrap without creating document-wide horizontal overflow.

## Elevation & Depth

Most surfaces are flat and separated by tonal change or a fine border; employee cards and ordinary list rows do not gain a resting shadow. The existing soft shadow marks focus within the chat composer, while the larger theme-paired shadow is reserved for overlays such as the mobile drawer, toast, and mail composer. Shadow values live in the sidecar extensions because the DESIGN.md token schema has no shadow primitive.

## Shapes

Controls, chips, and list selections use the gently rounded 8px control corner; containing editors and overlays use the 12px container corner. Borders stay thin and functional. The identity signature uses a one-pixel accent rule attached to author metadata, not a colored stripe around a generic card. Text fields and textareas retain native resize and selection behavior; placeholders use the secondary text color at full opacity so they remain readable in both themes.

## Components

The component language is quiet and native: clear action hierarchy, visible keyboard focus, and state communicated with both words and color.

### Buttons
- **Shape:** The shared control corner, with 40px standard height and compact horizontal padding.
- **Primary:** Solid theme accent for sending or composing; disabled actions visibly reduce emphasis.
- **Secondary:** A raised neutral surface for supporting actions; hover shifts to the existing raised-hover token.
- **Danger:** A pale error surface with semantic error text, distinct from the primary action.
- **Hover / Focus:** Native hover states remain restrained. Keyboard focus uses a 2px accent outline with 3px offset; the rail switches that outline to its high-contrast text color.
- **Icon-only:** 36px square at fine pointer; coarse-pointer rules raise its minimum target to 44px.

### Chips
- **Style:** Compact status labels use semantic success, warning, error, info, or muted foreground/background pairs, with a clear text label.
- **State:** Chips report existing status or counts; they are not oversized status cards or decorative badges.

### Cards / Containers
- **Corner Style:** Employee cards use the control radius; editors and overlays use the larger container radius.
- **Background:** Employee cards stay transparent at rest and use a subtle hover/selected surface when interactive.
- **Shadow Strategy:** Flat at rest; overlays use the existing theme-aware shadow vocabulary.
- **Border:** A quiet divider outlines employee cards and editor boundaries.
- **Internal Padding:** Employee cards follow the 16px spacing step; editor and reading surfaces use the surrounding layout rhythm.

### Inputs / Fields
- **Style:** Native input, select, and textarea controls use a clean surface, thin divider, and control radius; standard single-line fields are 40px high.
- **Focus:** The accent moves to the field border and visible focus outline.
- **Placeholder / Disabled:** Placeholder color is secondary ink with opacity 1. Disabled controls remain visibly subdued and non-interactive.

### Navigation
The rail uses a stable aubergine background with 40px room rows. A work selector sits at the top and only filters what gets created next; channels and DMs keep their fixed work. The selected destination fills the full row and carries a narrow inset leading marker; labels and secondary room details remain readable at compact density. Mail folders are flat, left-aligned rows rather than pills. On narrow viewports the workspace navigation becomes a drawer, while mail switches to a native folder select at its own container threshold.

### Identity Marginalia
A 32px generated mosaic avatar sits beside a metadata line with a one-pixel accent lead-in: a rounded 5×5 SVG pattern derived deterministically from the employee id, drawn from one of six low-saturation identity palettes with a matching dark-theme variant. Renaming an employee never changes the pattern, and deleted employees keep theirs in history. Author names use the UI role; role, address, and time use secondary metadata. Reuse this grammar in chat messages, mail messages, employee cards, and member lists, and only show role details when supplied by the existing employee record. Users and system notices keep the neutral initial; the mosaic is reserved for employees and is `aria-hidden` — the name and role next to it carry the identity, and no control is labeled by the pattern alone.

### Chat Composer
The composer is a single 840px-aligned frame, with a multiline prose field above a member chip row and the send action. Typing `@` opens a keyboard-driven suggestion list of the channel's enabled members and `@all`; choosing a suggestion inserts the full address, and chips address members without typing. A live line under the field previews exactly who will reply (`replies: A, B`, `no one is addressed`, or the addressing error), and the frame states that the message is visible to everyone. Focus is expressed by the containing frame so the textarea does not draw a competing inner ring. On narrow screens the toolbar remains a row and the message field remains reachable above the keyboard.

## Do's and Don'ts

### Do:
- **Do** use the paired theme tokens for surfaces, ink, selection, accent, and navigation.
- **Do** keep chat and mail at equal visual priority, with bounded reading measures and shared author metadata.
- **Do** preserve the author's name and nearby secondary details as a single identity line.
- **Do** use native buttons, selects, inputs, and textareas with visible keyboard focus.
- **Do** keep status color tied to the existing success, warning, and error meanings.

### Don't:
- **Don't** add remote fonts, UI libraries, or a second theme-token mechanism.
- **Don't** turn monospace into the voice for ordinary prose or use text glyphs as substitute icons.
- **Don't** lower placeholder opacity or rely on color alone for focus, selection, or status.
- **Don't** move the identity marginalia rule onto generic cards, list rows, or alerts.
- **Don't** imply employee availability through decoration; display only real status information already present in the interface.
