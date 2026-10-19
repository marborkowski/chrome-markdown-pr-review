# Markdown PR Review

A Chrome extension (Manifest V3, React + TypeScript) for reviewing Markdown in GitHub pull requests the way you review a document instead of a diff.
It works on **github.com**, **GitHub Enterprise Server** and **GHE.com**.

## Features

- **Rendered review view** for every `.md` / `.markdown` / `.mdx` file in a PR, with GitHub's own Markdown styling, light and dark. GitHub alerts (`> [!NOTE]`, `[!WARNING]`, …) render like on GitHub.
- **Links work inside the review.** `#anchor` links scroll to the heading, and links to another Markdown file of the same PR open that file in the review (Ctrl/⌘-click opens GitHub instead).
- **Changes highlighted in the rendered document.** Added blocks are green, modified blocks amber, and deleted passages appear as red "Removed" blocks. **Word diff** mode shows exactly which words changed inside a paragraph, list item, heading or code block, keeping the rest of the block and its formatting (code, emphasis, links).
- **Comment on any selected text.** Select a phrase and press **Comment** (or `c`). The extension maps the selection to the exact source line(s), even inside long, soft-wrapped paragraphs, and quotes the selected text in the comment.
- **Suggested changes.** **Suggest** pre-fills a GitHub ```` ```suggestion ```` block with the source lines, so the author can apply it with one click.
- **Draft reviews.** Collect comments locally across files, edit or delete them, then **Finish review** with Comment / Approve / Request changes. You can also post a single comment right away with **Comment now**. Drafts written before the PR got new commits are flagged so you can check their lines.
- **Existing conversations** appear as badges next to the block they refer to and in a side panel. You can reply and **resolve / unresolve** them there; resolved and outdated conversations are tucked away in their own sections.
- **Viewed state** stays in sync with GitHub's "Viewed" checkbox.
- **Source mode**: the raw Markdown with line numbers and the diff, also commentable.
- Keyboard shortcuts: `n`/`p` for the next/previous change, `[`/`]` to switch files, `v` to mark a file viewed, `c` / `s` to comment on / suggest a change to the selection, `Ctrl/⌘+Enter` to save, `Esc` to close. `Alt+Shift+M` opens the panel from anywhere on a PR. `Esc` in a half-written comment asks for a second `Esc` before discarding it.

GitHub only accepts line comments on lines inside a diff hunk. If your selection falls outside the changed part of a file, the extension tells you and posts a **file-level comment** instead, with the quote and line numbers included. On old GHE servers that don't support file comments, it falls back to a PR conversation comment.

## Install (unpacked)

```bash
npm install
npm run build          # outputs dist/
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the `dist/` folder.
3. Open the extension's **Options** (right-click the toolbar icon → Options).

### Token

The extension calls the GitHub REST/GraphQL API with a **classic** personal access token, one per GitHub instance:

1. In Options, click **Generate a classic token** next to the instance. This opens `https://<instance>/settings/tokens/new?scopes=repo` with the scope preselected. Alternatively, go to *Settings → Developer settings → Personal access tokens → Tokens (classic)*.
2. Select **only the `repo` scope**. It covers reading PRs and files, posting comments and reviews, and the "Viewed" state. If you only review public repositories, `public_repo` is enough. No other scopes (`write:discussion`, `workflow`, `admin:*`, …) are needed.
3. If your organization uses SAML SSO, click **Configure SSO → Authorize** for that organization.
4. Paste the token into Options and click **Save**. You should see "Connected as @login".

Fine-grained tokens (`github_pat_…`) are not supported. Organizations often restrict them, and comments then fail with "Resource not accessible by personal access token".

Tokens are stored only in `chrome.storage.local`. Only the background service worker ever reads them, and it sends each token only to the API URL configured for its own host. They are never exposed to the GitHub page.

### GitHub Enterprise

In Options → **GitHub Enterprise**, enter your instance URL, e.g. `https://github.acme.corp`. Chrome asks for permission to access that host (the extension declares `optional_host_permissions` and requests them at runtime). The API URL is derived automatically:

| Instance | API URL |
|---|---|
| GitHub Enterprise Server | `https://HOST/api/v3` (GraphQL: `/api/graphql`) |
| GHE.com (`*.ghe.com`) | `https://api.SUBDOMAIN.ghe.com` |

You can override it if your server uses a different URL. After you add an instance, the background worker registers the content script for that host dynamically (`chrome.scripting.registerContentScripts`). Reload any tabs of that instance that were already open. Clicking the toolbar icon on an instance that isn't configured yet opens Options with its URL prefilled.

## How it works

```
src/
  background/index.ts      service worker: API proxy (token lives here), pagination,
                           dynamic content scripts for GHE hosts, toolbar/shortcut
  content/
    index.tsx              mounts the React app in a Shadow DOM (isolated from GitHub CSS)
    App.tsx                detects PR pages (SPA-aware), launcher button
    components/Review.tsx  the review overlay: files, document, threads, review flow
    components/MarkdownDoc.tsx  react-markdown renderer with per-block diff/comment UI
    lib/patch.ts           parses the unified diff → added lines, removals, hunks
    lib/annotate.ts        rehype plugin: tags elements with source line ranges and
                           marks the smallest block owning each changed/commented line
    lib/anchor.ts          selection → source lines; lines → valid GitHub comment anchor
    lib/inlineDiff.ts      word diff of a block's Markdown source, rendered as Markdown
    lib/gfm.ts             GitHub alerts, heading ids (GitHub slugs), anchor lookup
  options/                 settings page (React)
  shared/                  host config + message types
```

Rendering uses `react-markdown` with `remark-gfm` (tables, task lists, strikethrough) and `remark-frontmatter`. Raw HTML is not rendered, which is safe by default. Relative links and images resolve to the PR's head commit.

## Development

```bash
npm run dev         # rebuild on change (reload the extension in chrome://extensions)
npm test            # unit tests (diff parsing, line mapping, annotation)
npm run typecheck

# UI playground with a mocked GitHub API:
npm run harness && python3 -m http.server 8765
#   → http://localhost:8765/dev/harness.html   (#dark for dark mode)
node dev/e2e.mjs            # automated UI test against the harness (Playwright)
#   on macOS: CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node dev/e2e.mjs

# Real extension against a fake GitHub Enterprise server:
node dev/mock-ghe.mjs &  node dev/ext-e2e.mjs
```

## Limitations / ideas

- Mermaid diagrams are shown as code blocks, not rendered.
- Draft comments are kept in the extension, not as a GitHub "pending review". They are submitted together as one review. If you have a pending review started in GitHub's own UI, submit or discard it first.
- Commenting on *removed* text (the left side of the diff) isn't supported. Comment on the surrounding new text instead.
