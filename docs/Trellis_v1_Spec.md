# Trellis: v1 Spec

Oct 30, 2026 · @MrBigCheeseMan

## Overview

Trellis is a web app, with a local version of the same app, that stores project notes as small atoms and shows them as a weighted 3D graph where related atoms sit close together. Claude and ChatGPT save atoms into it automatically through a connector. It is built for projects, so every atom belongs to a project, and the graph can show one project or all of them together.

**UI wording rule:** every label, menu, and button uses the plain name for what it is (Projects, Notes, Search, Review, Settings). No poetic or themed phrasing anywhere in the interface.

## Atoms

An atom is one self-contained statement of one to three sentences. Atoms are small on purpose: a bad chunking rule makes a junk graph.

| Field | What it holds |
| --- | --- |
| Text | The statement itself |
| Type | Decision, fact, task, idea, or question |
| Status | Decided (the user said or confirmed it) or proposed (the AI suggested it) |
| Project | The project it belongs to, or Unsorted |
| Source | Which AI and which chat it came from |
| Importance | How often it is referenced, whether it is pinned, and an AI-rated score |
| Created / Updated | Timestamps, used for the recency fade |
| Embedding | The vector that decides where it sits in the graph |

## Saving rules

The AI saves only what the user decided or stated, and anything uncertain waits on the Review page.

**Save:** decisions, stated facts about the project, constraints, tasks and commitments, open questions.

**Don't save:** small talk, options that were rejected or never picked, AI suggestions the user didn't adopt, and temporary state such as a bug that is happening right now.

1. Search for near-identical atoms first. If one exists (similarity above a threshold, to be tuned, starting near 0.9), raise its weight instead of adding a duplicate.
2. If the new atom contradicts an old one, save it and link the two as "replaces". The old atom dims.
3. The AI picks the project from the project list. If unsure, it uses Unsorted instead of guessing.
4. Confident atoms save automatically. Uncertain atoms go to the Review page, where the user approves, edits, or deletes them.

These rules live in the connector's tool descriptions, because that is what the model reads when deciding whether to call Save note. Tuning the wording there is the main way to tune behavior.

## Connections

One MCP server is the main connection. Claude's custom connectors are remote MCP servers, so the same server serves as the Claude connector. ChatGPT also supports MCP connectors, but that setup changes often, so check its current docs before building against it. A plain REST API with API keys covers anything else that wants to write in.

| Tool | What it does |
| --- | --- |
| Save note | Creates an atom with type, status, project, and source |
| Search notes | Finds atoms by meaning, so the AI can check for duplicates before saving |
| List projects | Returns the project names so the AI can pick one |
| Update note | Edits an atom or changes its status |

The MCP server needs sign-in tied to the user's account, so each connector only reaches that user's atoms. The local version works with Claude Desktop. claude.ai cannot reach a server on a laptop unless it is tunneled to a public address.

## Weights and layout

Three separate signals decide how the graph looks, so each one means one thing.

- **Distance between atoms:** similarity. Atoms above a similarity threshold get a link, and the link strength is the similarity score.
- **Atom size:** importance. Frequently referenced, pinned, or AI-rated atoms are larger.
- **Atom fade:** recency. Older atoms dim but never disappear.

The layout is force-directed: linked atoms pull together and all atoms push apart. Positions are computed, not saved. The simulation starts from the previous positions when new atoms arrive, so the existing graph shifts slightly instead of scrambling. The 3D rendering uses three.js, with the 3d-force-graph library for the first version.

## Projects and layers

Each atom belongs to exactly one project, and each project is its own layer with its own color. Links between atoms in different projects are allowed, so related ideas still connect across layers.

- The user can show one project, several, or all together.
- Atoms the AI could not place sit in an Unsorted layer until the user moves them.
- Hiding a layer hides its atoms and the links that only touch them.

## Graph interactions

| Action | What happens |
| --- | --- |
| Click an atom | A details panel opens with its text, type, status, project, source, weight, and a clickable list of connected atoms |
| Drag an atom | It pulls its neighbors, then everything settles back. Positions are not saved. An optional Pin button can freeze one later |
| Filter | By project, type, status, date range, and a minimum weight slider that hides faint atoms |
| Search | Highlights matching atoms in the graph |
| Edit | Text is edited in the details panel. Saving re-generates the embedding so the atom moves to its correct spot |
| Delete | Moves the atom to Trash for 30 days, then removes it for good. Restore is available from Trash |
| Review | A separate page listing uncertain atoms with Approve, Edit, and Delete buttons |

## Desktop and iPad layout

The graph fills the window, with two side panels that open and close so the graph keeps as much room as possible.

- **Left panel:** the Projects list (checkbox and color per project) and the filters. It collapses to a single button.
- **Right panel:** the details panel for the selected atom. It opens on click and closes with Esc or its close button.
- **Top bar:** Search, Review (with a count of waiting atoms), and Settings.

**Desktop controls:** drag to orbit, scroll to zoom, right-drag to pan, click to select, double-click an atom to center on it. Keyboard: / opens Search, Esc closes panels, E edits the selected atom, Delete moves it to Trash.

**iPad controls:** one finger orbits, two fingers pan and zoom, tap selects, and long-press on an atom opens a menu with Edit, Delete, and Pin. In portrait, both panels start closed and open as overlays over the graph. In landscape, the left panel stays open and the right panel opens on tap. Every button is at least 44 points tall so fingers can hit it.

## Mobile layout

The mobile version is the same web app with a layout built for one hand and a small screen. It is installable to the home screen. The 3D graph is hard to use on a phone, so every graph action also has a list-based alternative.

**Navigation:** a bottom bar with four buttons: Graph, Notes, Review, Settings. Buttons sit at the bottom so a thumb can reach them.

**Graph screen:**

- One finger orbits, two fingers pan, pinch zooms, double-tap recenters. A Reset view button is always visible.
- Atoms are small, so each one has an invisible larger tap area.
- The graph opens on one project instead of all of them, and shows the heaviest atoms first. Lighter atoms load as the user zooms in, which keeps it smooth on phones.
- A Filter button opens a bottom sheet with Projects, Type, Status, and the minimum weight slider.

**Atom details:** tapping an atom opens a bottom sheet at half height with its text and three buttons: Edit, Delete, Connected. Swiping up expands it to full screen. Swiping down closes it.

**Notes screen:** a searchable list of atoms with the same filters. Tapping one opens the same details sheet and highlights it in the graph. This is the fallback when the 3D view is awkward.

**Review screen:** one atom at a time. Swipe right to approve, swipe left to delete, and Approve, Edit, and Delete buttons do the same for anyone who prefers tapping.

## Accounts and hosting

Sign-in uses passkeys: the user unlocks with a fingerprint or face on their phone or laptop, and there are no passwords. This works on both the hosted and local versions.

The web app is built first and hosted. The local version is the same app run on the user's machine, with Postgres and pgvector in Docker so the hosted and local databases are identical and only one version of the code exists. Each hosted user's atoms are isolated from every other user's.

## Build order and open questions

The graph comes after the connector so the layout can be tuned on real atoms instead of fake ones.

1. **Storage:** atoms, projects, and embeddings in Postgres with pgvector.
2. **Connector:** the MCP server with Save note, Search notes, List projects, and Update note, plus the Review page.
3. **Graph view:** 3D graph with the projects filter, details panel, and editing.
4. **Accounts:** passkey sign-in.
5. **Layouts:** the desktop, iPad, and mobile layouts above.
6. **Local version:** package the same app to run on the user's machine.

**Open questions**

- [ ] Which embedding model to use, hosted API or a local model for the local version? Whichever has best quality for quantity or vice versa.
- [ ] What happens if a user loses their passkey device (second passkey, or a recovery code)? Recovery
- [ ] Does ChatGPT's current connector support work with the MCP server as built? Idk
- [ ] What similarity threshold counts as a duplicate, and where do links start? At least 75%+
- [ ] Is mobile an installable web app first, or a native app later? Web app
