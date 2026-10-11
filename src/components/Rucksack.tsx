import type {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
} from "@quartz-community/types";
import {
  CONFIG_SCRIPT_PREFIX,
  configAttributes,
  resolveConfig,
  serializeConfig,
  type RucksackOptions,
} from "../lib/config";
import style from "./styles/rucksack.scss";
// @ts-expect-error - inline script import handled by the Quartz/esbuild inline-script-loader
import script from "./scripts/rucksack.inline.ts";

export type { RucksackOptions } from "../lib/config";

export default ((opts?: RucksackOptions) => {
  const config = resolveConfig(opts);
  const { title, icon, className } = config;

  // The runtime needs the same config, and it runs on every page - including
  // pages with no panel - so it is written onto the element and inlined into the
  // script. Attributes win over the inlined object, so a hand-edited page can
  // still override a setting.
  const attrs: Record<string, string> = { "data-rucksack": "", ...configAttributes(config) };

  const Rucksack: QuartzComponent = (_props: QuartzComponentProps) => {
    return (
      <aside class={className} {...attrs}>
        <button type="button" class="rucksack-toggle" data-rucksack-toggle>
          <span class="rucksack-icon" aria-hidden="true">
            {icon}
          </span>
          <span class="rucksack-label">{title}</span>
          <span class="rucksack-count" data-rucksack-count>
            0
          </span>
        </button>

        <div class="rucksack-panel" data-rucksack-panel hidden>
          <p class="rucksack-empty" data-rucksack-empty>
            Nothing stashed yet. Use
            <code>{config.stashLabel}</code> on any fenced block.
          </p>

          <ul class="rucksack-list" data-rucksack-entries></ul>

          <div class="rucksack-actions">
            <button
              type="button"
              class="rucksack-clear"
              data-rucksack-show-all
              hidden
            >
              Show all
            </button>
          </div>
        </div>

        <div class="rucksack-modal" data-rucksack-modal hidden>
          <div class="rucksack-modal-backdrop" data-rucksack-modal-backdrop></div>

          <div
            class="rucksack-modal-content"
            role="dialog"
            aria-modal="true"
            aria-label={`${title} — all stashed blocks`}
          >
            <div class="rucksack-modal-header">
              <span class="rucksack-modal-title">{title}</span>
              <button
                type="button"
                class="rucksack-modal-close"
                data-rucksack-modal-close
                aria-label="Close"
              >
                &#10005;
              </button>
            </div>

            <p class="rucksack-modal-hint">
              Entries keep the quantity and location written in their fence. Stash
              the same thing again to add more of it.
            </p>

            <ul
              class="rucksack-list rucksack-modal-list"
              data-rucksack-modal-entries
            ></ul>

            <div class="rucksack-actions">
              <button
                type="button"
                class="rucksack-clear"
                data-rucksack-clear
                hidden
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      </aside>
    );
  };

  Rucksack.css = style;
  // Two scripts, in order: the resolved config, then the runtime that reads it.
  Rucksack.afterDOMLoaded = [
    `${CONFIG_SCRIPT_PREFIX}${serializeConfig(config)};`,
    script,
  ];

  return Rucksack;
}) satisfies QuartzComponentConstructor<RucksackOptions>;