# Changelog

## Unreleased

- Stash buttons now mount on every page (even without an inventory panel) and are
  re-mounted after client-side navigation.
- Fixed one-line ```item fences rendering empty; only genuinely blank rendered
  lines are dropped.
- Stashing an item now hides its text inside the fenced block.
- Replaced the panel "Clear" button with "Show all", which opens a themed modal
  containing the full inventory (with a Clear button inside).
- Item links now reproduce the exact page path they were stashed from, fixing
  404s for nested pages and trailing-slash URLs.
- Inventory entries render as plain text instead of links, and names longer than
  20 characters are elided (`Lorem Ipsum ladada b…`) with the full title kept in
  the tooltip. Stored titles stay untouched.
- Entries now carry a `category` taken from the fence language, so ` ```event `
  and ` ```secret ` blocks are stowable too (see `ITEM_CATEGORIES`).

## 0.1.0

- Initial release: Quartz v5 Inventory component with `localStorage` persistence.