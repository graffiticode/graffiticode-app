// The part of pngjs (https://github.com/pngjs/pngjs) core uses: a full decode
// of a PNG, which throws if it can't (profile/assets.ts).
declare module "pngjs" {
  const pngjs: { PNG: { sync: { read(buffer: Buffer): { width: number; height: number; data: Buffer } } } };
  export default pngjs;
}
