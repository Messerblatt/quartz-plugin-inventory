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

## 0.1.0

- Initial release: Quartz v5 Inventory component with `localStorage` persistence.