import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";
import path from "path";

/**
 * Sounds are inlined as data URIs so a published plugin works from any static
 * host with no asset pipeline and no extra fetch on first stash.
 *
 * Registered twice: once on the main build, and again inside the nested build
 * that compiles `.inline.ts`, which would otherwise fail to resolve the import.
 */
const assetLoader: Plugin = {
  name: "inline-asset-loader",
  setup(build) {
    build.onLoad({ filter: /\.mp3$/ }, async (args) => {
      const fs = await import("fs");
      const bytes = await fs.promises.readFile(args.path);
      const uri = `data:audio/mpeg;base64,${bytes.toString("base64")}`;
      return { contents: `export default ${JSON.stringify(uri)};`, loader: "js" };
    });
  },
};

/**
 * Esbuild plugin mirroring Quartz v5's own `inline-script-loader`:
 *  - `.scss`      -> compiled with sass, loaded as a CSS text string
 *  - `.inline.ts` -> transpiled + bundled for the browser, loaded as a JS text string
 *  - `.mp3`       -> inlined as a base64 data URI (the plugin ships no files)
 *
 * Components then do `Component.css = style` / `Component.afterDOMLoaded = script`.
 */
const inlineScriptPlugin: Plugin = {
  name: "inline-script-loader",
  setup(parentBuild) {
    const absWorkingDir = parentBuild.initialOptions.absWorkingDir ?? process.cwd();

    parentBuild.onLoad({ filter: /\.scss$/ }, async (args) => {
      const sass = await import("sass");
      const result = sass.compile(args.path);
      return { contents: result.css, loader: "text" };
    });

    parentBuild.onLoad({ filter: /\.inline\.ts$/ }, async (args) => {
      const esbuild = await import("esbuild");
      const fs = await import("fs");
      let text = await fs.promises.readFile(args.path, "utf8");

      // Inline scripts run inside a <script> tag, not as ES modules.
      text = text.replace(/^export default /gm, "");
      text = text.replace(/^export /gm, "");

      const result = await esbuild.build({
        stdin: {
          contents: text,
          loader: "ts",
          resolveDir: path.dirname(args.path),
          sourcefile: path.relative(absWorkingDir, args.path),
        },
        write: false,
        bundle: true,
        minify: true,
        platform: "browser",
        format: "esm",
        target: "es2020",
        sourcemap: false,
        external: ["http://*", "https://*"],
        plugins: [assetLoader],
      });

      const js = result.outputFiles?.[0]?.text;
      if (!js) throw new Error(`inline-script-loader: no JS output for ${args.path}`);
      return { contents: js, loader: "text" };
    });
  },
};

const SINGLETON_EXTERNALS = [
  "preact",
  "preact/hooks",
  "preact/jsx-runtime",
  "preact/compat",
  "@jackyzha0/quartz",
  "@jackyzha0/quartz/*",
  "vfile",
  "vfile/*",
  "unified",
];

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "components/index": "src/components/index.ts",
  },
  format: ["esm"],
  dts: true,
  tsconfig: "tsconfig.build.json",
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  splitting: false,
  outDir: "dist",
  platform: "node",
  noExternal: [/.*/],
  external: SINGLETON_EXTERNALS,
  banner: {
    js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
  },
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.jsxImportSource = "preact";
  },
  esbuildPlugins: [inlineScriptPlugin],
});
