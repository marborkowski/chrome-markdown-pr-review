<h1 align="center">Markdown PR Review</h1>

<p align="center">
  Review the Markdown in a GitHub pull request the way you read a document, not a diff.<br>
  A Chrome extension for <b>github.com</b>, <b>GitHub Enterprise Server</b> and <b>GHE.com</b>.
</p>

<p align="center">
  <a href="#license"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Chrome extension, Manifest V3" src="https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4.svg">
  <img alt="React + TypeScript" src="https://img.shields.io/badge/React%2018-TypeScript-3178C6.svg">
</p>

<p align="center">
  <img src="docs/review.png" alt="The review overlay: a rendered document with changed paragraphs highlighted, the file list on the left and conversations on the right" width="900">
</p>

Open a pull request, press **Review Markdown**, and a full-page **overlay** shows every `.md` file of the PR as a rendered page with GitHub's own styling. Changed paragraphs are highlighted, a **Word diff** shows exactly which words changed, and you comment by selecting text – the extension works out the source lines for you and posts a normal GitHub review comment.

## Contents

- [Features](#features)
- [Install](#install)
- [Setup](#setup)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [How comments are placed](#how-comments-are-placed)
- [How it works](#how-it-works)
- [Development](#development)
- [Privacy](#privacy)
- [Limitations](#limitations)
- [License](#license)

## Features

### Read

- **Rendered view** of every `.md`, `.markdown`, `.mdown`, `.mkd` and `.mdx` file in the PR, in GitHub's light or dark Markdown styling (it follows your GitHub theme). Tables, task lists, strikethrough and GitHub alerts (`> [!NOTE]`, `> [!WARNING]`, …) render like on GitHub; YAML front matter is shown as a code block at the top of the document instead of being dropped.
- **Working links.** `#anchor` links scroll inside the overlay, links to another Markdown file of the same PR open that file in the overlay (Ctrl/⌘-click opens GitHub instead), and relative links and images resolve to the PR's head commit.
- **Mermaid diagrams** (```` ```mermaid ```` blocks) are rendered as diagrams. The Mermaid library (~5 MB) is loaded only when a document actually contains one.
- **Source mode** shows the raw Markdown with line numbers and the diff, and is just as commentable.

### See what changed

- **Changes in the rendered document.** Added blocks are green, modified blocks amber, and deleted passages appear as collapsible red *Removed N lines* blocks. `n` / `p` jump between changes.
- **Word diff.** Inside a changed paragraph, list item, heading or code block the exact words that changed are marked, while the rest of the block keeps its formatting – code spans, emphasis and links survive. A change that spans several list items or paragraphs stays split into those items.
- **Diagram diff.** When a Mermaid diagram changed, its **Changes** view shows what changed inside the diagram:
  - a **flowchart** becomes one merged diagram – added nodes and edges green, removed ones red and dashed, relabelled nodes amber;
  - every other diagram type (sequence, class, state, ER, gantt, pie, …) is shown **Before / After** side by side, with the labels that exist on one side only highlighted.

  **After**, **Before** and **Source** switch to the single versions and to the code block.

- **Deleted, new and renamed files.** A file the PR deletes is still shown – its last version from the base commit – under a *deleted* banner; comments on it are file-level and **Suggest** is disabled. A brand-new file gets a *New file* banner and no change highlighting (everything would be green, so `n` / `p` have nothing to jump to). Renamed files show *old → new* in the file bar, and the file list marks files **A** / **D** / **R**.

### Review

- **Comment on any selected text.** Select a phrase and press **Comment** (or `c`). The selection is mapped to the exact source line(s), even inside long, soft-wrapped paragraphs, and quoted in the comment. Deleted words of a word diff stay ~~struck through~~ in the quote.
- **Suggest a change.** **Suggest** (or `s`) pre-fills a ```` ```suggestion ```` block with the source lines, so the author can apply it with one click.
- **Draft reviews.** Collect comments across files, edit or delete them in the side panel, then **Finish review** as *Comment*, *Approve* or *Request changes*. Drafts are kept per pull request and survive page reloads and browser restarts until you submit or delete them. **Comment now** posts a single comment immediately. After you reload the PR (⟳) following new commits, drafts written against the older commit are flagged so you can check their lines.
- **Conversations** show up as badges next to the block they refer to and in the side panel, where you can reply and **resolve / unresolve** them. Resolved and outdated conversations are tucked away in their own sections.
- **Viewed** state stays in sync with GitHub's *Viewed* checkbox (`v`), and marking a file viewed moves on to the next unviewed one.

### Header

The header holds the **Rendered / Source** switch, the **Word diff** toggle (on by default, in Rendered mode), a change counter with **↑ / ↓**, **⟳** to reload the pull request after it received new commits (your drafts and the open file are kept) and **☰** to hide or show the side panel. The Rendered/Source, Word diff and side-panel choices are remembered per GitHub host; the file you were reading is remembered per pull request for as long as the tab is open.

## Install

The extension is built from source and loaded unpacked. You need **Node.js 18 or newer** (with npm) and **Chrome 110 or newer**:

```bash
npm install
npm run build          # builds dist/
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `dist/` folder.
3. Open the extension's **Options** (right-click the toolbar icon → *Options*) and add a token (optional for reading public repositories on github.com, see [Setup](#setup)).
4. Open a pull request. Once its file list has loaded, a **Review Markdown** button with the number of Markdown files appears bottom-right; the toolbar icon and `Alt`+`Shift`+`M` open and close the same review.

On a pull request without Markdown files the button is not shown, and the toolbar icon or shortcut only show a note saying so. If the extension can't reach the API, the button's icon turns amber (hover it for the error): **Connect a token to review Markdown** means no token is saved for this instance and opens Options; **Markdown review unavailable – retry** reloads the pull request data.

## Setup

### Token

The extension calls the GitHub REST and GraphQL APIs with a **classic** personal access token, one per GitHub instance. On github.com the token is optional for *reading* pull requests in public repositories – GitHub's unauthenticated limit of 60 requests per hour applies, and the launcher turns into *Connect a token* once it is hit. Commenting, replying, resolving conversations and the *Viewed* state always need one. To create a token:

1. In Options, click **Generate a classic token** next to the instance. It opens `https://<instance>/settings/tokens/new?scopes=repo` with the scope preselected. (Manually: *Settings → Developer settings → Personal access tokens → Tokens (classic)*.)
2. Select **only the `repo` scope**. It covers reading pull requests and files, posting comments and reviews, resolving conversations and the *Viewed* state. For public repositories only, `public_repo` is enough. No other scopes are needed.
3. If your organization uses SAML single sign-on, click **Configure SSO → Authorize** for that organization, or its repositories stay invisible to the token.
4. Paste the token into Options and click **Save**. You should see *Connected as @login*.

Fine-grained tokens (`github_pat_…`) are not supported: organizations often restrict them, and comments then fail with *Resource not accessible by personal access token*.

### GitHub Enterprise

In Options → **GitHub Enterprise**, enter the instance URL, e.g. `https://github.acme.corp`. Chrome asks for permission to run on that host (the extension declares it as an *optional* host permission and requests it only then). The API URL is derived automatically and can be overridden:

| Instance | API URL |
|---|---|
| GitHub Enterprise Server | `https://HOST/api/v3` (GraphQL: `https://HOST/api/graphql`) |
| GHE.com (`*.ghe.com`) | `https://api.SUBDOMAIN.ghe.com` |

After an instance is added, the background worker registers the content script for it; reload tabs of that instance that were already open. Clicking the toolbar icon on an instance that isn't configured yet opens Options with its URL prefilled.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Alt` + `Shift` + `M` | Open or close the overlay (works anywhere on a PR page) |
| `n` / `p` | Next / previous change |
| `[` / `]` | Previous / next file |
| `v` | Toggle *Viewed* for the current file |
| `c` / `s` | Comment on / suggest a change to the selected text |
| `Ctrl` + `Enter` (⌘ on Mac) | Add the comment to the review, send a reply, submit the review dialog |
| `Ctrl` + `Shift` + `Enter` | Post the comment immediately |
| `Esc` | Close the dialog, then the overlay. In a half-written comment it asks for a second `Esc` before discarding it |

Only `Alt` + `Shift` + `M` is a Chrome command and can be rebound at `chrome://extensions/shortcuts`; the other keys are fixed and work only while the review is open.

## How comments are placed

GitHub only accepts line comments on lines inside a diff hunk, and a multi-line comment must stay inside one hunk. The extension picks the best valid anchor for your selection:

| Your selection | What gets posted |
|---|---|
| Inside the changed part of the file | A line comment on exactly those lines (trimmed to the hunk if it spilled over) |
| Outside every hunk, or the file has no diff | A **file-level comment** with the quote and line numbers in its body |
| In a file deleted by the PR | A file-level comment (the file has no "right side" to comment on) |

The composer tells you which of these applies before you post. On old GitHub Enterprise servers without file-level comments, the file comment becomes a regular PR conversation comment.

## How it works

The content script mounts a React app inside a Shadow DOM, isolated from GitHub's CSS, on every `/owner/repo/pull/N` page. All API calls go through the background service worker, which holds the tokens.

```
src/
  background/index.ts         service worker: API proxy (tokens live here), pagination,
                              dynamic content scripts for Enterprise hosts, toolbar button and shortcut
  content/
    index.tsx                 mounts the app in a Shadow DOM host, follows GitHub's light/dark theme
    App.tsx                   detects PR pages (SPA-aware), the launcher button
    api.ts                    GitHub client (REST + GraphQL via the background worker): comments with the
                              file-comment → conversation-comment fallback, reviews, replies, viewed, resolve;
                              and the draft store (chrome.storage.local, keyed by pull request)
    types.ts                  PR / file / comment / draft types, isMarkdown()
    components/
      Review.tsx              the overlay: file list, document, side panel, review flow, shortcuts
      MarkdownDoc.tsx         react-markdown renderer; every block gets its source line range,
                              change markers, comment badges and the word-diff mode
      MermaidBlock.tsx        diagram block with the Changes / After / Before / Source views
      SourceDoc.tsx           source mode
      Composer.tsx            the comment / suggestion composer
      Threads.tsx             conversations and drafts in the side panel
      SubmitReview.tsx        the "Finish review" dialog
      WordDiff.tsx            plain word diff, used for code blocks and the ± "what changed" popover
      ErrorBoundary.tsx       keeps a document that fails to render from taking down the review
    lib/
      patch.ts                parses the unified diff → added lines, removals, hunks
      annotate.ts             rehype plugin: tags blocks with line ranges, marks changed and commented blocks
      anchor.ts               selection → source lines; lines → a valid GitHub comment anchor
      inlineDiff.ts           word diff of a block's Markdown source, rendered as Markdown
      quote.ts                selection → quoted text (keeps deletions struck through)
      gfm.ts                  GitHub alerts, heading ids (GitHub slugs), anchor lookup
      mermaid.ts              loads dist/mermaid.js on demand, parses and renders diagrams
      mermaidDiff.ts          merges two flowcharts and works out what to colour
  mermaid/entry.ts            built separately into dist/mermaid.js (ES module) and import()ed
                              by the content script only when a document has a diagram
  options/                    the settings page
  shared/                     host configuration and message types
```

Rendering uses `react-markdown` with `remark-gfm` and `remark-frontmatter`; raw HTML in Markdown is not rendered. Mermaid diagrams are rendered with `securityLevel: 'strict'`. Draft comments are kept in `chrome.storage.local`, keyed by pull request.

## Development

```bash
npm run dev          # rebuild dist/ on change
npm test             # unit tests: diff parsing, line mapping, annotation, word diff, rendering
npm run typecheck
npm run zip          # npm run build + pack dist/ into markdown-pr-review.zip
```

Chrome doesn't pick up a new build by itself: click the reload icon on the extension's card in `chrome://extensions`, then reload the GitHub tabs that were already open. A tab still running the old content script fails its API calls with *The extension was updated. Reload this page to continue.*

A UI playground runs the real review UI against a mocked GitHub API, with fixtures for a modified, an added and a deleted file:

```bash
npm run harness && python3 -m http.server 8765
# → http://localhost:8765/dev/harness.html   (add #dark for dark mode)

# Automated UI test against the harness (Playwright). On macOS point it at Chrome:
CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node dev/e2e.mjs
# node dev/e2e.mjs [screenshotDir]   # screenshots go to dev/out by default
# HARNESS_URL=http://localhost:8767 node dev/e2e.mjs   # harness served on another port (default 8765)
```

The real extension can be tested end to end against a fake GitHub Enterprise server (host configuration, dynamic content script, API through the service worker):

```bash
npm run build
node dev/mock-ghe.mjs &
CHROMIUM="<path to Chrome for Testing>" node dev/ext-e2e.mjs
```

Branded Google Chrome no longer accepts `--load-extension`; use Chrome for Testing (Playwright installs one under `~/Library/Caches/ms-playwright/chromium-*/`).

## Privacy

- Tokens are stored only in the browser's extension storage (`chrome.storage.local`). Only the background service worker reads them, and it sends each token only to the API URL of its own GitHub instance. They are never exposed to the GitHub page.
- The extension talks to nothing but the GitHub instances you configure. There is no telemetry.
- It runs on `github.com` out of the box; access to an Enterprise host is requested only when you add it in Options.

## Limitations

- Draft comments live in the extension, not as a GitHub *pending review*. Line comments are submitted together as one review; file-level drafts (see [How comments are placed](#how-comments-are-placed)) can't be part of a review, so they are posted one by one as separate comments right after it. This is also why *Request changes* needs a summary or at least one line comment, while *Approve* can be sent on its own. If you have a pending review started in GitHub's own UI, submit or discard it there first.
- Comments go on the new version of a file. Commenting on *removed* text (the left side of the diff) isn't supported – comment on the surrounding text instead.
- The merged **Changes** diagram is built for flowcharts; other Mermaid diagram types fall back to the Before / After view.

## License

[MIT](LICENSE) © 2026 Marcin Borkowski
