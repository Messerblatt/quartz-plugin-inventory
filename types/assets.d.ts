declare module "*.scss" {
  const content: string;
  export default content;
}

declare module "*.inline.ts" {
  const content: string;
  export default content;
}

declare module "*.inline.tsx" {
  const content: string;
  export default content;
}

declare module "*.mp3" {
  /** Base64 data URI, inlined by the build so the plugin needs no network. */
  const content: string;
  export default content;
}
